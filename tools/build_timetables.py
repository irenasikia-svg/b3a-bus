"""Build per-route timetable files from the Transport Department's GTFS feed.

The feed (DATA.GOV.HK, "Public transport - headway") lists, for every bus route, the departures
from the first stop as time windows with a headway. Its server does not allow browser requests,
so this script converts it once into small JSON files the page can load:

    timetables/<ROUTE>.json   one file per route number, all KMB / LWB / Citybus variants
    timetables/holidays.json  public holiday dates (from the Sunday-and-holiday services)

Usage:  python3 tools/build_timetables.py [path/to/gtfs.zip]
Without a path it downloads the current feed.
"""
import csv
import io
import json
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

FEED = "https://static.data.gov.hk/td/pt-headway-tc/gtfs.zip"
AGENCIES = {"KMB", "LWB", "CTB", "KMB+CTB", "LWB+CTB"}
OUT = Path(__file__).resolve().parent.parent / "timetables"
DAY_NAMES = "一二三四五六日"


def read(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, "utf-8-sig"))


def hhmm(t):
    h, m = t.split(":")[:2]
    return f"{int(h) % 24:02d}:{m}"


def minutes(t):
    h, m = t.split(":")[:2]
    return int(h) * 60 + int(m)


def day_label(mask, holidays):
    days = [i for i, on in enumerate(mask) if on == "1"]
    if len(days) == 7:
        return "每日"
    # collapse runs like 一至五
    parts, run = [], []
    for d in days + [None]:
        if run and (d is None or d != run[-1] + 1):
            if len(run) <= 2:
                parts.extend(DAY_NAMES[x] for x in run)
            else:
                parts.append(f"{DAY_NAMES[run[0]]}至{DAY_NAMES[run[-1]]}")
            run = []
        if d is not None:
            run.append(d)
    label = "星期" + "、".join(parts) if parts else ""
    if holidays:
        label = f"{label}及公眾假期" if label else "公眾假期"
    return label


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    data = Path(src).read_bytes() if src else urllib.request.urlopen(FEED, timeout=120).read()
    z = zipfile.ZipFile(io.BytesIO(data))

    routes = {r["route_id"]: r for r in read(z, "routes.txt") if r["agency_id"] in AGENCIES}
    stops = {s["stop_id"]: (round(float(s["stop_lat"]), 5), round(float(s["stop_lon"]), 5)) for s in read(z, "stops.txt")}

    calendar = {c["service_id"]: "".join(c[d] for d in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"))
                for c in read(z, "calendar.txt")}
    added = defaultdict(int)
    holiday_dates = set()
    for c in read(z, "calendar_dates.txt"):
        if c["exception_type"] == "1":
            added[c["service_id"]] += 1
            holiday_dates.add(c["date"])

    trips = {}  # trip_id -> (route_id, bound, service_id)
    for t in read(z, "trips.txt"):
        if t["route_id"] in routes:
            bound = t["trip_id"].split("-")[1]
            trips[t["trip_id"]] = (t["route_id"], bound, t["service_id"])

    # First and last stop (and first departure) of each trip.
    first, last = {}, {}
    for st in read(z, "stop_times.txt"):
        tid = st["trip_id"]
        if tid not in trips:
            continue
        seq = int(st["stop_sequence"])
        if tid not in first or seq < first[tid][0]:
            first[tid] = (seq, st["stop_id"], st["departure_time"])
        if tid not in last or seq > last[tid][0]:
            last[tid] = (seq, st["stop_id"])

    freqs = defaultdict(list)
    for f in read(z, "frequencies.txt"):
        if f["trip_id"] in trips:
            freqs[f["trip_id"]].append((f["start_time"], f["end_time"], int(f["headway_secs"]) // 60))

    # (route_id, bound) -> service_id -> rows; a row is [start, end, headway] or [time]
    table = defaultdict(lambda: defaultdict(list))
    ends = {}
    for tid, (rid, bound, svc) in trips.items():
        if tid not in first:
            continue
        key = (rid, bound)
        ends.setdefault(key, (first[tid][1], last[tid][1]))
        if freqs[tid]:
            for s, e, h in freqs[tid]:
                table[key][svc].append((minutes(s), [hhmm(s), hhmm(e), h]))
        elif first[tid][2]:
            table[key][svc].append((minutes(first[tid][2]), [hhmm(first[tid][2])]))

    by_route = defaultdict(list)
    for (rid, bound), services in table.items():
        r = routes[rid]
        orig, dest = [x.strip() for x in r["route_long_name"].split(" - ", 1)] if " - " in r["route_long_name"] else (r["route_long_name"], "")
        if bound == "2":
            orig, dest = dest or orig, orig
        # Merge services that run the same timetable into one day group.
        groups = {}
        for svc, rows in services.items():
            rows = [x[1] for x in sorted(rows, key=lambda x: x[0])]
            sig = json.dumps(rows, ensure_ascii=False)
            mask = calendar.get(svc, "0000000")
            g = groups.setdefault(sig, {"mask": ["0"] * 7, "holidays": False, "rows": rows})
            g["mask"] = ["1" if a == "1" or b == "1" else "0" for a, b in zip(g["mask"], mask)]
            g["holidays"] = g["holidays"] or added[svc] >= 3
        days = []
        for g in groups.values():
            mask = "".join(g["mask"])
            days.append({"label": day_label(mask, g["holidays"]), "mask": mask, "holidays": g["holidays"], "rows": g["rows"]})
        days.sort(key=lambda d: (d["mask"].find("1") if "1" in d["mask"] else 9, d["holidays"]))
        a, b = ends[(rid, bound)]
        by_route[r["route_short_name"]].append({
            "agency": r["agency_id"], "from": orig, "to": dest,
            "o": stops.get(a), "d": stops.get(b), "days": days,
        })

    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    total = 0
    for route, variants in by_route.items():
        path = OUT / f"{route}.json"
        text = json.dumps(variants, ensure_ascii=False, separators=(",", ":"))
        path.write_text(text, "utf-8")
        total += len(text.encode())
    (OUT / "holidays.json").write_text(json.dumps(sorted(holiday_dates)), "utf-8")
    print(f"{len(by_route)} routes, {total / 1024:.0f} KB total, {len(holiday_dates)} holiday dates")


if __name__ == "__main__":
    main()
