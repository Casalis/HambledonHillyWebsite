"""Embed the results CSVs (results/<year>_<distance>k.csv) into site/results.html.

The data goes between the RESULTS-DATA markers in the page, so the page stays a single
static file. Re-run after adding or correcting a results CSV:

    python tools/build_results_page.py
"""
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / 'results'
PAGE = ROOT / 'site' / 'results.html'
START, END = '/* RESULTS-DATA:START */', '/* RESULTS-DATA:END */'


def secs(t):
    if not t:
        return None
    s = sum(float(x) * 60**i for i, x in enumerate(reversed(t.split(':'))))
    return round(s, 1)


def load_race(path):
    year, km = re.fullmatch(r'(\d{4})_(\d+)k', path.stem).groups()
    rows = []
    for r in csv.DictReader(open(path, encoding='utf-8')):
        # [position, name, gender, category, age, club, gender position, time, chip time, bib]
        rows.append([
            int(r['Position']), r['Name'], r['Gender'], r['Category'],
            int(r['Age']) if r['Age'] else None, r['Club'],
            int(r['Gender Position']) if r['Gender Position'] else None,
            secs(r['Time']), secs(r['Chip Time']), r['Bib'],
        ])
    return {'year': int(year), 'km': int(km), 'rows': rows}


def main():
    races = [load_race(p) for p in sorted(RESULTS.glob('[0-9][0-9][0-9][0-9]_*k.csv'))]
    races.sort(key=lambda r: (r['year'], r['km']))
    data = json.dumps(races, separators=(',', ':'), ensure_ascii=False)
    page = PAGE.read_text(encoding='utf-8')
    a, b = page.index(START) + len(START), page.index(END)
    PAGE.write_text(page[:a] + '\nconst RACES = ' + data + ';\n' + page[b:], encoding='utf-8')
    print(f'{len(races)} races, {sum(len(r["rows"]) for r in races)} results -> {PAGE}')


if __name__ == '__main__':
    main()
