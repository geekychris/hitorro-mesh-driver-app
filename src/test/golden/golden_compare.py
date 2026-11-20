#!/usr/bin/env python3
"""Normalise and compare golden REST records.
usage: golden_compare.py A.jsonl B.jsonl [--show N]
Volatile values become typed placeholders that keep their FORMAT (so ISO-vs-epoch, fraction digits and
zone style still differ): timestamps of the run day, epoch ms near now, 8-hex query ids, *Ms/*Millis/pid
values. JSON arrays listed in UNORDERED (by JSON path) are compared as sorted multisets."""
import json, re, sys, time

ISO = re.compile(r'(?P<y>[+]?\d{4,6})-(?P<mo>\d\d)-(?P<d>\d\d)T\d\d:\d\d:\d\d(?P<frac>\.\d+)?(?P<z>Z|[+-]\d\d:?\d\d)?')
def today_like(m, days):
    return (m.group('y') + '-' + m.group('mo') + '-' + m.group('d')) in days
def norm_text(s, days):
    def iso(m):
        if not today_like(m, days): return m.group(0)
        f = m.group('frac'); z = m.group('z') or ''
        return '<ISO' + (':f%d' % (len(f) - 1) if f else '') + (':' + z if z else '') + '>'
    s = ISO.sub(iso, s)
    now = time.time() * 1000
    s = re.sub(r'(?<![\d.])1[6-9]\d{11}(?![\d.])', lambda m: '<EPOCHMS>' if abs(int(m.group(0)) - now) < 5 * 86400e3 else m.group(0), s)
    s = re.sub(r'(?<![\d.])1[6-9]\d{8}(?![\d.])', lambda m: '<EPOCHS>' if abs(int(m.group(0)) * 1000 - now) < 5 * 86400e3 else m.group(0), s)
    s = re.sub(r'\b(?=[0-9a-f]*\d)[0-9a-f]{8}\b', '<HEX8>', s)
    # which partition's retry fails first is a race on main too
    s = re.sub(r'(task <HEX8>:)[\w-]+(:retry\d)', r'\1<PK>\2', s)
    # set-valued string arrays (hash-set order): sort their items textually; nothing else is touched
    s = re.sub(r'"(requiredCapabilities|capabilities|liveCapabilities|declaredCapabilities|assignedAgents|eligibleAgents)":\[("(?:[^"\\]|\\.)*"(?:,"(?:[^"\\]|\\.)*")*)\]',
               lambda m: '"%s":[%s]' % (m.group(1), ','.join(sorted(re.findall(r'"(?:[^"\\]|\\.)*"', m.group(2))))), s)
    s = re.sub(r'"(\w*(?:Ms|Millis|millis|Nanos|nanos|Seconds)|pid|uptime\w*|elapsed\w*)"\s*:\s*-?\d+(\.\d+)?', lambda m: '"%s":<N>' % m.group(1), s)
    s = re.sub(r'(\b(?:pid|PID)[ =:])\d+', r'\1<N>', s)
    return s

UNORDERED = set()  # filled per app: JSON paths like '$.assignedAgents'

def canon(v, path='$'):
    if isinstance(v, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canon(x, path + '.' + k) for k, x in v.items()) + '}'
    if isinstance(v, list):
        items = [canon(x, path + '[]') for x in v]
        if path in UNORDERED or path.split('.')[-1] in UNORDERED: items = sorted(items)
        return '[' + ','.join(items) + ']'
    return json.dumps(v, ensure_ascii=False)

def normalise(r, days):
    body = norm_text(r['resp'], days)
    ct = r['ctype']
    if 'json' in ct:
        try:
            # keep the raw text (exact bytes) AND an order-insensitive form for unordered paths
            body = canon(json.loads(body, object_pairs_hook=dict)) if UNORDERED else body
        except Exception:
            pass
    if 'event-stream' in ct:
        events = body.split('\n\n')
        body = '\n\n'.join(events)
    return (r['req'], r.get('body'), r['status'], ct.split(';')[0], body)

def load(p):
    import gzip
    opener = gzip.open if p.endswith('.gz') else open
    with opener(p, 'rt', encoding='utf-8') as fh:
        return [json.loads(l) for l in fh]

def sorted_canon(v):
    if isinstance(v, dict):
        return '{' + ','.join(sorted(json.dumps(k, ensure_ascii=False) + ':' + sorted_canon(x) for k, x in v.items())) + '}'
    if isinstance(v, list):
        return '[' + ','.join(sorted(sorted_canon(x) for x in v)) + ']'
    return json.dumps(v, ensure_ascii=False)

def loose(t):
    """Order-insensitive form of a normalised record (for records whose order varies on main itself)."""
    req, body, st, ct, resp = t
    resp = re.sub(r'([:,\[])(<[A-Z0-9:]+>)', r'\1"\2"', resp)  # bare placeholders -> strings, so it parses
    try:
        resp = sorted_canon(json.loads(resp))
    except Exception:
        lines = []
        for l in resp.split('\n'):
            if l.startswith('data:'):
                try: l = 'data:' + sorted_canon(json.loads(re.sub(r'([:,\[])(<[A-Z0-9:]+>)', r'\1"\2"', l[5:])))
                except Exception: pass
            lines.append(l)
        resp = '\n'.join(lines)
    return (req, body, st, ct, resp)

if __name__ == '__main__':
    # golden_compare.py MAIN1[,MAIN2,...] CANDIDATE   (a record that is identical across all main runs must
    # match exactly; one whose order varies across main runs is compared order-insensitively)
    mains = sys.argv[1].split(','); cand = sys.argv[2]
    days = {time.strftime('%Y-%m-%d', time.gmtime(time.time() + d * 86400)) for d in (-1, 0, 1)}
    M = [load(m) for m in mains]; C = load(cand)
    diffs = 0; loose_n = 0; unstable = 0
    if any(len(x) != len(C) for x in M): print('record count differs', [len(x) for x in M], len(C)); diffs += 1
    for k, rc in enumerate(C):
        ns = [normalise(x[k], days) for x in M]
        nc = normalise(rc, days)
        if all(n == ns[0] for n in ns):
            ok = nc == ns[0]; mode = 'exact'
        elif all(loose(n) == loose(ns[0]) for n in ns):
            ok = loose(nc) == loose(ns[0]); mode = 'order-insensitive'; loose_n += 1
        else:
            unstable += 1
            print('UNSTABLE on main itself: #%d %s' % (rc['i'], rc['req'][:90]))
            continue
        if not ok:
            diffs += 1
            print('=== #%d %s (%s)' % (rc['i'], rc['req'][:100], mode))
            for lab, x, y in zip(('req', 'body', 'status', 'ctype', 'resp'), ns[0], nc):
                if x != y: print('  %s:\n    main: %s\n    new:  %s' % (lab, str(x)[:700], str(y)[:700]))
    print('DIFFERENCES: %d of %d (order-insensitive: %d, unstable on main: %d)' % (diffs, len(C), loose_n, unstable))
    sys.exit(1 if diffs or unstable else 0)
