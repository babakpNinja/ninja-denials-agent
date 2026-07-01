#!/usr/bin/env python3
"""Synthetic data + agent-logic generator for the Autonomous Denials Management
& Appeals Agent POC. Everything here is FAKE, generated deterministically.

Outputs (written to ../public/data/):
  claims.json          5,000 denied claims (full)
  claims.csv           same, CSV
  clinical_notes.json  ~30 synthetic clinical-note snippets keyed by claim_id
  ledger.json          800 historical appeal outcomes + derived win-rate matrix
  letters.json         10 fully-generated appeal letters
  evolution.json       12-week self-learning win-rate curve
  summary.json         KPI rollups + chart aggregates + activity feed
"""
import csv
import json
import os
import random
from datetime import date, timedelta

from faker import Faker

SEED = 20260701
random.seed(SEED)
fake = Faker()
Faker.seed(SEED)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "data")
os.makedirs(OUT, exist_ok=True)

TODAY = date(2026, 7, 1)

# ---------------------------------------------------------------- reference data
PAYERS = [
    "Medicare Advantage", "BCBS", "UnitedHealthcare", "Aetna", "Cigna",
    "Medicaid MCO",
]
# relative volume weights (payer mix)
PAYER_WEIGHTS = [0.24, 0.22, 0.20, 0.14, 0.12, 0.08]

# CARC codes: code -> (group, human reason, base overturn prob)
CARC = {
    "CO-50":  ("Medical Necessity", "These are non-covered services because this is not deemed a 'medical necessity' by the payer.", 0.58),
    "CO-97":  ("Bundling",          "The benefit for this service is included in the payment/allowance for another service already adjudicated.", 0.44),
    "PR-204": ("Non-Covered",       "This service/equipment/drug is not covered under the patient's current benefit plan.", 0.33),
    "CO-16":  ("Missing Info",      "Claim/service lacks information or has submission/billing error(s) needed for adjudication.", 0.72),
    "CO-197": ("Prior Auth",        "Precertification/authorization/notification/pre-treatment absent.", 0.66),
    "CO-29":  ("Timely Filing",     "The time limit for filing this claim has expired.", 0.21),
}
CARC_WEIGHTS = {
    "CO-50": 0.24, "CO-97": 0.18, "PR-204": 0.14,
    "CO-16": 0.20, "CO-197": 0.16, "CO-29": 0.08,
}
# Prior mean win-rate per denial group = the CARC base overturn rate. Used to
# Bayesian-shrink small-sample win rates so none read an artificial 100% / 0%.
GROUP_BASE = {grp: base for (grp, _reason, base) in CARC.values()}
WINRATE_PRIOR_K = 6   # pseudo-observations of prior strength
WINRATE_CAP = (0.06, 0.94)

# payer-specific difficulty multiplier on overturn probability
PAYER_DIFFICULTY = {
    "Medicare Advantage": 1.08, "BCBS": 1.02, "UnitedHealthcare": 0.86,
    "Aetna": 0.95, "Cigna": 0.92, "Medicaid MCO": 1.00,
}

# DRG catalogue: code -> description (real-ish MS-DRG style)
DRGS = [
    ("470", "Major hip & knee joint replacement w/o MCC"),
    ("871", "Septicemia w/o MV >96 hrs w MCC"),
    ("291", "Heart failure & shock w MCC"),
    ("247", "Perc cardiovascular proc w drug-eluting stent w/o MCC"),
    ("069", "Transient ischemia"),
    ("194", "Simple pneumonia & pleurisy w CC"),
    ("853", "Infectious & parasitic diseases w O.R. proc w MCC"),
    ("330", "Major small & large bowel procedures w CC"),
    ("460", "Spinal fusion except cervical w/o MCC"),
    ("065", "Intracranial hemorrhage or cerebral infarction w CC"),
    ("885", "Psychoses"),
    ("377", "G.I. hemorrhage w MCC"),
    ("189", "Pulmonary edema & respiratory failure"),
    ("683", "Renal failure w CC"),
    ("638", "Diabetes w CC"),
    ("948", "Signs & symptoms w/o MCC"),
    ("743", "Uterine & adnexa proc for non-malignancy w CC/MCC"),
    ("312", "Syncope & collapse"),
    ("308", "Cardiac arrhythmia & conduction disorders w MCC"),
    ("287", "Circulatory disorders except AMI, w card cath w/o MCC"),
]

STATUSES = ["new", "in-progress", "appealed", "won", "lost", "written-off"]
STATUS_WEIGHTS = [0.34, 0.18, 0.16, 0.14, 0.08, 0.10]

# argument types the "agent" can deploy, per CARC group
ARGUMENTS = {
    "Medical Necessity": ["InterQual criteria citation", "MCG guideline citation", "Peer-reviewed literature", "Attending physician attestation"],
    "Bundling":          ["NCCI edit rebuttal", "Modifier-59 distinct-service", "Separate encounter documentation"],
    "Non-Covered":       ["Plan-document benefit citation", "Medical policy exception", "Prudent-layperson standard"],
    "Missing Info":      ["Corrected claim resubmission", "Itemized bill attachment", "Records completeness packet"],
    "Prior Auth":        ["Retro-authorization request", "Emergency-exception clause", "Auth-on-file cross-reference"],
    "Timely Filing":     ["Proof-of-timely-submission", "Payer-delay documentation", "Good-cause exception"],
}


def weighted(choices, weights):
    return random.choices(choices, weights=weights, k=1)[0]


def money_lognormal():
    # log-normal centered so most claims are $2k-$40k, tail to $250k
    v = random.lognormvariate(9.4, 0.95)
    return round(min(max(v, 500.0), 250000.0), 2)


# ---------------------------------------------------------------- learning ledger
def build_ledger():
    """800 past appeal outcomes → win-rate matrix by (payer, argument)."""
    rows = []
    for i in range(800):
        payer = weighted(PAYERS, PAYER_WEIGHTS)
        carc = weighted(list(CARC_WEIGHTS), list(CARC_WEIGHTS.values()))
        group = CARC[carc][0]
        arg = random.choice(ARGUMENTS[group])
        base = CARC[carc][2] * PAYER_DIFFICULTY[payer]
        # arg-specific edge: some arguments are stronger
        edge = 1.0
        strong = {
            "InterQual criteria citation": 1.22, "MCG guideline citation": 1.15,
            "NCCI edit rebuttal": 1.18, "Retro-authorization request": 1.12,
            "Corrected claim resubmission": 1.20, "Proof-of-timely-submission": 1.25,
        }
        edge = strong.get(arg, 1.0)
        p = max(0.05, min(0.95, base * edge))
        won = random.random() < p
        d = TODAY - timedelta(days=random.randint(30, 540))
        rows.append({
            "outcome_id": f"H{100000+i}",
            "payer": payer, "carc": carc, "carc_group": group,
            "argument": arg, "won": won,
            "decision_date": d.isoformat(),
            "amount": money_lognormal(),
        })

    # derive win-rate matrix: payer -> argument -> {n, wins, win_rate}
    matrix = {}
    for r in rows:
        m = matrix.setdefault(r["payer"], {}).setdefault(r["argument"], {"n": 0, "wins": 0, "carc_group": r["carc_group"]})
        m["n"] += 1
        m["wins"] += 1 if r["won"] else 0
    # Bayesian-shrink each win rate toward its group's base rate: a small sample
    # (e.g. 4/4) is pulled toward the prior instead of reading a fake 100%.
    for payer, args in matrix.items():
        for arg, m in args.items():
            base = GROUP_BASE.get(m["carc_group"], 0.5)
            smoothed = (m["wins"] + base * WINRATE_PRIOR_K) / (m["n"] + WINRATE_PRIOR_K)
            m["raw_win_rate"] = round(m["wins"] / m["n"], 3) if m["n"] else 0.0
            m["win_rate"] = round(min(WINRATE_CAP[1], max(WINRATE_CAP[0], smoothed)), 3)

    # best argument per (payer, carc_group)
    best = {}
    for payer, args in matrix.items():
        for arg, m in args.items():
            key = f"{payer}|{m['carc_group']}"
            cur = best.get(key)
            # need a minimum sample size to be credible
            if m["n"] >= 4 and (cur is None or m["win_rate"] > cur["win_rate"]):
                best[key] = {"argument": arg, "win_rate": m["win_rate"], "n": m["n"]}
    return rows, matrix, best


def overturn_prob(payer, carc, best):
    """Blended historical overturn probability for a payer/CARC combo."""
    group = CARC[carc][0]
    base = CARC[carc][2] * PAYER_DIFFICULTY[payer]
    b = best.get(f"{payer}|{group}")
    if b:
        base = 0.4 * base + 0.6 * b["win_rate"]
    return round(max(0.05, min(0.95, base)), 3)


# ---------------------------------------------------------------- clinical notes
CHIEF = ["Acute onset chest pain", "Shortness of breath x3 days", "Altered mental status",
         "Right lower quadrant abdominal pain", "Syncopal episode at home", "Fever and productive cough",
         "Left-sided weakness", "Uncontrolled hyperglycemia", "Post-op wound infection", "Severe dehydration"]
FINDINGS = ["Troponin elevated at 0.42 ng/mL", "CT demonstrates 4mm hyperdensity",
            "WBC 18.2 with left shift", "Lactate 3.8 mmol/L", "SpO2 88% on room air",
            "EF reduced to 35% on echo", "Blood cultures positive for gram-negative rods",
            "A1c 11.4%, glucose 388 mg/dL", "CTA positive for segmental PE"]
TREATMENTS = ["IV antibiotics (piperacillin-tazobactam)", "Continuous cardiac telemetry",
              "Heparin drip per protocol", "BiPAP initiated", "Emergent PCI with DES placement",
              "Insulin drip and fluid resuscitation", "48h ICU-level monitoring", "Surgical debridement"]


def clinical_note():
    return {
        "chief_complaint": random.choice(CHIEF),
        "key_findings": random.sample(FINDINGS, k=random.randint(2, 3)),
        "treatments": random.sample(TREATMENTS, k=random.randint(2, 3)),
        "los_days": random.randint(1, 9),
    }


# ---------------------------------------------------------------- claims
def build_claims(best):
    claims = []
    notes = {}
    for i in range(5000):
        cid = 40000 + i
        payer = weighted(PAYERS, PAYER_WEIGHTS)
        carc = weighted(list(CARC_WEIGHTS), list(CARC_WEIGHTS.values()))
        group, reason, _ = CARC[carc]
        drg_code, drg_desc = random.choice(DRGS)
        amount = money_lognormal()
        service = TODAY - timedelta(days=random.randint(35, 210))
        denial = service + timedelta(days=random.randint(14, 55))
        # payer appeal window: 60-180 days from denial
        deadline = denial + timedelta(days=random.choice([60, 90, 120, 180]))
        days_to_deadline = (deadline - TODAY).days
        status = weighted(STATUSES, STATUS_WEIGHTS)
        p_overturn = overturn_prob(payer, carc, best)
        urgency = urgency_score(days_to_deadline)
        expected_recovery = round(amount * p_overturn * urgency, 2)
        claims.append({
            "claim_id": cid,
            "patient_name": fake.name(),
            "mrn": f"MRN{random.randint(1000000, 9999999)}",
            "drg_code": drg_code, "drg_desc": drg_desc,
            "service_date": service.isoformat(),
            "billed_amount": amount,
            "payer": payer,
            "carc": carc, "carc_group": group, "denial_reason": reason,
            "denial_date": denial.isoformat(),
            "appeal_deadline": deadline.isoformat(),
            "days_to_deadline": days_to_deadline,
            "status": status,
            "overturn_prob": p_overturn,
            "urgency": urgency,
            "priority_score": expected_recovery,
        })
    # ~30 claims get clinical notes (pick high-value medical-necessity ones)
    ranked = sorted(claims, key=lambda c: c["priority_score"], reverse=True)
    for c in ranked[:30]:
        notes[str(c["claim_id"])] = clinical_note()
        c["has_clinical_note"] = True
    return claims, notes


def urgency_score(days):
    if days <= 0:
        return 0.55          # past deadline (good-cause only)
    if days <= 7:
        return 1.00
    if days <= 15:
        return 0.90
    if days <= 30:
        return 0.75
    if days <= 60:
        return 0.60
    return 0.45


# ---------------------------------------------------------------- appeal letters
def build_letter(claim, note, best):
    payer = claim["payer"]
    group = claim["carc_group"]
    b = best.get(f"{payer}|{group}")
    arg = b["argument"] if b else random.choice(ARGUMENTS[group])
    win = b["win_rate"] if b else claim["overturn_prob"]
    amt = f"${claim['billed_amount']:,.2f}"
    reasons = {
        "Medical Necessity": (
            f"The denial cites CARC {claim['carc']} (medical necessity). The clinical record "
            f"unambiguously supports the medical necessity of the admission and services rendered."),
        "Bundling": (
            f"The denial cites CARC {claim['carc']} (bundling). The services in question were distinct, "
            f"separately identifiable, and independently documented."),
        "Non-Covered": (
            f"The denial cites CARC {claim['carc']} (non-covered). The service is, in fact, a covered "
            f"benefit under the member's plan document for the diagnosis presented."),
        "Missing Info": (
            f"The denial cites CARC {claim['carc']} (missing information). The complete documentation is "
            f"enclosed herewith, resolving the stated deficiency."),
        "Prior Auth": (
            f"The denial cites CARC {claim['carc']} (no prior authorization). The services met emergency "
            f"and medical-necessity criteria warranting retrospective authorization."),
        "Timely Filing": (
            f"The denial cites CARC {claim['carc']} (timely filing). Documentation demonstrates the claim "
            f"was submitted within the contractual filing window."),
    }[group]

    evidence = ""
    if note:
        findings = "; ".join(note["key_findings"])
        treatments = "; ".join(note["treatments"])
        evidence = (
            f"\n\nCLINICAL SUMMARY OF RECORD\n"
            f"Chief complaint: {note['chief_complaint']}. "
            f"Objective findings on presentation included {findings}. "
            f"The patient required {treatments} over a {note['los_days']}-day length of stay. "
            f"These findings meet recognized severity-of-illness and intensity-of-service thresholds.")

    body = f"""{TODAY.strftime('%B %d, %Y')}

Appeals Department
{payer}
Re: Formal Appeal of Claim Denial

Patient: {claim['patient_name']}
Medical Record No.: {claim['mrn']}
Claim ID: {claim['claim_id']}
Date of Service: {claim['service_date']}
DRG {claim['drg_code']} — {claim['drg_desc']}
Billed Amount: {amt}
Denial Code: {claim['carc']}

To the Appeals Review Committee:

We formally appeal the above-referenced denial and request full reversal and payment. {reasons}

Our appeal rests on the strongest evidentiary basis for this determination: a {arg}. In our reviewed
history, this argument has prevailed against {payer} on {group.lower()} denials in {round(win*100)}% of
comparable cases, and the present claim is materially stronger than the median overturned case.{evidence}

Accordingly, the denial is not supported by the clinical facts or the governing plan and medical-policy
language. We request that {payer} overturn denial {claim['carc']} and remit payment of {amt} within the
timeframe required by applicable regulation and the provider agreement. Supporting documentation is
enclosed. Please direct correspondence to the Revenue Integrity Appeals Unit.

Respectfully submitted,

Revenue Integrity Appeals Unit
Meridian Regional Health System
Autonomous Appeals Agent — reviewed & queued for e-signature"""
    return {
        "claim_id": claim["claim_id"],
        "payer": payer,
        "carc": claim["carc"],
        "argument": arg,
        "predicted_win": round(win, 3),
        "billed_amount": claim["billed_amount"],
        "reasoning_chain": [
            f"Classify denial: {claim['carc']} → {group}.",
            f"Retrieve payer history for {payer} × {group}.",
            f"Select strongest argument: {arg} (hist. win {round(win*100)}%).",
            "Pull cited clinical evidence from record." if note else "No clinical note on file — cite plan/policy language.",
            f"Compute expected recovery = ${claim['billed_amount']:,.0f} × {claim['overturn_prob']} overturn × {claim['urgency']} urgency = ${claim['priority_score']:,.0f}.",
            "Draft payer-addressed letter; queue for e-signature.",
        ],
        "letter_text": body,
    }


# ---------------------------------------------------------------- self-evolution
def build_evolution():
    """12 simulated weeks of the agent 'learning' — win-rate climbs and plateaus."""
    weeks = []
    wr = 0.38
    drafted_total = 0
    for w in range(1, 13):
        wr += random.uniform(0.012, 0.028) * (1.0 - wr)  # diminishing gains
        wr = min(wr, 0.74)
        drafted = random.randint(180, 320)
        drafted_total += drafted
        weeks.append({
            "week": w,
            "label": f"W{w}",
            "win_rate": round(wr, 3),
            "appeals_drafted": drafted,
            "cumulative_drafted": drafted_total,
            "recovered": round(drafted * wr * random.uniform(6800, 9200), 0),
        })
    return weeks


# ---------------------------------------------------------------- activity feed
def build_feed(claims):
    top = sorted(claims, key=lambda c: c["priority_score"], reverse=True)[:40]
    feed = []
    h, m = 0, 0
    for c in top:
        m += random.randint(2, 9)
        h += m // 60
        m %= 60
        hh = h % 24
        stamp = f"{hh:02d}:{m:02d} {'AM' if hh < 12 else 'PM'}"
        feed.append({
            "time": stamp,
            "claim_id": c["claim_id"],
            "amount": c["billed_amount"],
            "carc": c["carc"],
            "payer": c["payer"],
            "predicted_win": c["overturn_prob"],
            "text": (f"Drafted appeal for claim #{c['claim_id']} "
                     f"(${c['billed_amount']:,.0f}, {c['carc']}, {short_payer(c['payer'])}) "
                     f"— predicted win {round(c['overturn_prob']*100)}%"),
        })
    return feed


def short_payer(p):
    return {"UnitedHealthcare": "UHC", "Medicare Advantage": "MA", "Medicaid MCO": "Medicaid"}.get(p, p)


# ---------------------------------------------------------------- summary/KPIs
def build_summary(claims, evolution):
    total_denied = sum(c["billed_amount"] for c in claims)
    open_claims = [c for c in claims if c["status"] in ("new", "in-progress", "appealed")]
    recoverable = sum(c["billed_amount"] * c["overturn_prob"] for c in open_claims)
    drafted_today = sum(1 for c in claims if c["status"] == "in-progress")
    won = [c for c in claims if c["status"] == "won"]
    resolved = [c for c in claims if c["status"] in ("won", "lost")]
    win_rate = (len(won) / len(resolved)) if resolved else 0.0
    projected_annual = recoverable * 2.4  # extrapolate the open pipeline across a year

    by_payer = agg(claims, "payer")
    by_carc = agg(claims, "carc")
    by_group = agg(claims, "carc_group")

    # recovery funnel
    denied_n = len(claims)
    appealed_n = sum(1 for c in claims if c["status"] in ("in-progress", "appealed", "won", "lost"))
    overturned_n = len(won)
    funnel = [
        {"stage": "Denied", "count": denied_n, "value": round(total_denied)},
        {"stage": "Triaged & Appealed", "count": appealed_n, "value": round(sum(c["billed_amount"] for c in claims if c["status"] in ("in-progress", "appealed", "won", "lost")))},
        {"stage": "Overturned (Recovered)", "count": overturned_n, "value": round(sum(c["billed_amount"] for c in won))},
    ]
    return {
        "total_denied": round(total_denied),
        "recoverable": round(recoverable),
        "appeals_drafted_today": drafted_today,
        "projected_annual_recovery": round(projected_annual),
        "current_win_rate": round(win_rate, 3),
        "total_claims": len(claims),
        "open_claims": len(open_claims),
        "by_payer": by_payer,
        "by_carc": by_carc,
        "by_carc_group": by_group,
        "funnel": funnel,
        "win_rate_trend": [w["win_rate"] for w in evolution],
        "win_rate_labels": [w["label"] for w in evolution],
    }


def agg(claims, key):
    d = {}
    for c in claims:
        k = c[key]
        e = d.setdefault(k, {"count": 0, "amount": 0.0})
        e["count"] += 1
        e["amount"] += c["billed_amount"]
    return [{"key": k, "count": v["count"], "amount": round(v["amount"])}
            for k, v in sorted(d.items(), key=lambda x: -x[1]["amount"])]


# ---------------------------------------------------------------- main
def main():
    ledger_rows, matrix, best = build_ledger()
    claims, notes = build_claims(best)
    evolution = build_evolution()

    # 10 example letters: top expected-recovery claims, prefer those with notes
    ranked = sorted(claims, key=lambda c: c["priority_score"], reverse=True)
    picks, seen_payers = [], {}
    for c in ranked:
        # spread across payers for a varied demo, cap 2 per payer among first pass
        if seen_payers.get(c["payer"], 0) < 2 or len(picks) >= 6:
            picks.append(c)
            seen_payers[c["payer"]] = seen_payers.get(c["payer"], 0) + 1
        if len(picks) == 10:
            break
    letters = [build_letter(c, notes.get(str(c["claim_id"])), best) for c in picks]

    summary = build_summary(claims, evolution)
    feed = build_feed(claims)

    write("claims.json", claims)
    write_csv("claims.csv", claims)
    write("clinical_notes.json", notes)
    write("ledger.json", {"rows": ledger_rows, "matrix": matrix, "best_arguments": best})
    write("letters.json", letters)
    write("evolution.json", evolution)
    write("summary.json", {**summary, "activity_feed": feed})

    print(f"claims={len(claims)} ledger={len(ledger_rows)} notes={len(notes)} "
          f"letters={len(letters)} weeks={len(evolution)} feed={len(feed)}")
    print(f"total_denied=${summary['total_denied']:,} recoverable=${summary['recoverable']:,} "
          f"proj_annual=${summary['projected_annual_recovery']:,} win_rate={summary['current_win_rate']}")


def write(name, obj):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(obj, f, separators=(",", ":"))


def write_csv(name, claims):
    cols = ["claim_id", "patient_name", "mrn", "drg_code", "drg_desc", "service_date",
            "billed_amount", "payer", "carc", "carc_group", "denial_reason",
            "denial_date", "appeal_deadline", "days_to_deadline", "status",
            "overturn_prob", "urgency", "priority_score"]
    with open(os.path.join(OUT, name), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for c in claims:
            w.writerow(c)


if __name__ == "__main__":
    main()
