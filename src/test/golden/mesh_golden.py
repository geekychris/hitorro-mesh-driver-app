#!/usr/bin/env python3
"""Golden REST capture (see run.sh) for hitorro-mesh-driver-app (+ agent-app): starts NATS (docker), two agents and a
driver from the given builds, runs a fixed request list, writes one record per request.
usage: mesh_golden.py --driver-cp CP --agent-cp CP --out FILE [--jar] [--work DIR]
--driver-cp/--agent-cp: either 'classes:deps' classpath (main build) or a fat jar path (with --jar)."""
import argparse, json, os, re, shutil, socket, subprocess, sys, tempfile, time, urllib.request, urllib.error

def repl(text, k, v):
    """Masks a run value: the work dir anywhere, a port only as ':<port>' (not inside other numbers)."""
    if k.isdigit():
        return re.sub(r'(?<=:)' + k + r'(?!\d)', v, text)
    return text.replace(k, v)

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

def http(method, url, body=None, ctype='application/json', timeout=30, accept=None):
    data = None
    if body is not None:
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None: req.add_header('Content-Type', ctype)
    if accept: req.add_header('Accept', accept)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get('Content-Type', ''), r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Content-Type', ''), e.read().decode('utf-8', 'replace')
    except Exception as e:
        return -1, '', 'EXC ' + type(e).__name__ + ' ' + str(e)

def wait_up(url, secs=120):
    t = time.time()
    while time.time() - t < secs:
        st, _, body = http('GET', url, timeout=3)
        if st == 200 and 'UP' in body: return True
        time.sleep(1)
    return False

TYPE = {"name": "docs", "fields": [
    {"name": "id", "type": "core_string"}, {"name": "title", "type": "core_string"},
    {"name": "lang", "type": "core_string"}, {"name": "size_kb", "type": "core_long"},
    {"name": "score", "type": "core_double"}, {"name": "created", "type": "core_string"}]}
ROWS = {
  "us": [{"id": "us-1", "title": "Quarterly \"Report\" é", "lang": "en", "size_kb": 210, "score": 1.10, "created": "2026-01-02T03:04:05Z", "meta": {"k": [1, 2]}},
         {"id": "us-2", "title": "Roadmap", "lang": "en", "size_kb": 84, "score": 2.5, "created": "2026-02-01T00:00:00Z"},
         {"id": "us-3", "title": "Hiring", "lang": "de", "size_kb": 12345678901, "score": -0.0, "created": None}],
  "eu": [{"id": "eu-1", "title": "Rapport", "lang": "fr", "size_kb": 512, "score": 1e30, "created": "2026-03-01T00:00:00Z"},
         {"id": "eu-2", "title": "四半期", "lang": "ja", "size_kb": 3, "score": 0.1}]}

def requests_list(work):
    q = lambda sql, **kw: ('POST', '/mesh/queries', dict({"sql": sql, "timeoutMs": 10000}, **kw))
    job = "job: demo\nnodes:\n  - id: a\n    pipeline: {source: {kind: inline, rows: [{x: 1}, {x: 2}]}, sinks: [{kind: counting, label: n}]}\n"
    sched = {"name": "nightly", "cron": "0 0 3 * * *", "jobYaml": job, "enabled": True, "extraField": 1}
    sched2 = {"name": "iso", "intervalSeconds": 3600, "jobYaml": job, "createdAt": "2026-01-02T03:04:05.123Z", "lastRunAt": 1767323045123, "description": "d\u00e9"}
    out = os.path.join(work, 'out')
    return [
      ('GET', '/actuator/health', None), ('GET', '/actuator/info', None),
      ('GET', '/actuator/health/liveness', None), ('GET', '/actuator/health/readiness', None),
      ('GET', '/actuator/metrics/jvm.info', None), ('GET', '/actuator/metrics/nope', None),
      ('GET', '/mesh/agents', None), ('GET', '/mesh/cluster', None), ('GET', '/mesh/topology', None),
      ('GET', '/mesh/tables', None),
      ('POST', '/mesh/tables', {"name": "docs", "typeJson": json.dumps(TYPE), "partitions": [{"key": "us"}, {"key": "eu", "approxRowCount": 2}]}),
      ('POST', '/mesh/tables', {"name": "", "typeJson": "{}", "partitions": []}),
      ('POST', '/mesh/tables', '{"name": "x", "typeJson": "{", "partitions": [{"key": "a"}]}'),
      ('GET', '/mesh/tables', None),
      q("SELECT id, title, lang, size_kb, score, created FROM docs ORDER BY id"),
      q("SELECT * FROM docs ORDER BY id"),
      q("SELECT id FROM docs WHERE lang = 'en' ORDER BY id"),
      q("SELECT lang, COUNT(*) AS n, SUM(size_kb) AS total, MIN(score) AS lo FROM docs GROUP BY lang"),
      q("SELECT id, size_kb FROM docs ORDER BY size_kb DESC LIMIT 2"),
      q("SELECT DISTINCT lang FROM docs"),
      q("SELECT nope FROM docs"), q("SELECT * FROM missing_table"), q("not sql at all"),
      ('POST', '/mesh/queries', {"sql": "SELECT id FROM docs ORDER BY id", "timeoutMs": 10000, "retries": 1, "semantic": False, "extra": "ignored"}),
      ('POST', '/mesh/queries', '{"sql": "SELECT id FROM docs ORDER BY id", "timeoutMs": "10000"}'),
      ('POST', '/mesh/queries', '{"sql": "SELECT id FROM docs ORDER BY id", "timeoutMs": null}'),
      ('POST', '/mesh/queries', '{bad json'),
      ('GET', '/mesh/queries/explain?sql=SELECT%20id%20FROM%20docs%20WHERE%20lang%20%3D%20%27en%27', None),
      ('GET', '/mesh/queries/explain?sql=SELECT%20lang%2C%20COUNT(*)%20FROM%20docs%20GROUP%20BY%20lang', None),
      ('GET', '/mesh/queries/explain?sql=garbage', None),
      ('GET', '/mesh/queries', None),
      ('SSE', '/mesh/queries/stream?sql=SELECT%20id%2C%20lang%20FROM%20docs%20ORDER%20BY%20id', None),
      ('SSE', '/mesh/queries/stream?sql=garbage', None),
      ('DELETE', '/mesh/queries/no-such-query', None),
      ('POST', '/mesh/broadcast-tables', {"name": "langs", "typeJson": json.dumps({"name": "langs", "fields": [{"name": "code", "type": "core_string"}]})}),
      ('DELETE', '/mesh/broadcast-tables/langs', None), ('DELETE', '/mesh/broadcast-tables/langs', None),
      ('GET', '/mesh/datasets/wins', None), ('GET', '/mesh/datasets', None), ('GET', '/mesh/datasets/nope', None),
      ('GET', '/mesh/catalog', None), ('GET', '/mesh/catalog/nope', None),
      ('GET', '/mesh/schedules', None), ('GET', '/mesh/schedules/templates', None),
      ('GET', '/mesh/schedules/templates/nope', None),
      ('POST', '/mesh/schedules', sched), ('POST', '/mesh/schedules', sched2), ('POST', '/mesh/schedules', {"name": "x"}),
      ('POST', '/mesh/schedules', '{"name": "bad", "jobYaml": "j", "createdAt": "not-a-date"}'),
      ('GET', '/mesh/schedules', None), ('GET', '/mesh/schedules/nightly', None), ('GET', '/mesh/schedules/iso', None),
      ('POST', '/mesh/schedules/nightly/run-now', None), ('SLEEP', '3', None), ('GET', '/mesh/schedules/nightly', None),
      ('POST', '/mesh/schedules/nightly/pause', None), ('POST', '/mesh/schedules/nightly/resume', None),
      ('GET', '/mesh/schedules/nightly/checkpoint', None),
      ('PUTTEXT', '/mesh/schedules/nightly/checkpoint', 'cp-1'),
      ('GET', '/mesh/schedules/nightly/checkpoint', None),
      ('DELETE', '/mesh/schedules/nightly', None), ('GET', '/mesh/schedules/nightly', None), ('DELETE', '/mesh/schedules/iso', None),
      ('GET', '/mesh/storage', None), ('GET', '/mesh/storage/browse', None), ('GET', '/mesh/storage/head?path=x', None),
      ('GET', '/mesh/storage/minio', None),
      ('GET', '/mesh/retrieval/federated/status', None),
      ('POST', '/mesh/retrieval/federated', {"query": "hello", "size": 3}),
      ('GET', '/mesh/retrieval/federated/kv/idx/k1', None),
      ('GET', '/mesh/retrieval/federated/kv/idx/scan', None),
      ('GET', '/mesh/fleet/services', None), ('GET', '/mesh/fleet/services/nope/logs', None),
      ('GET', '/mesh/fleet/services/nope/manifest', None), ('GET', '/mesh/fleet/driver-debug', None),
      ('GET', '/mesh/logs', None), ('GET', '/mesh/logs/nope', None),
      ('GET', '/mesh/search', None), ('GET', '/mesh/search/nope?q=x', None),
      ('GET', '/mesh/queries/registered', None), ('GET', '/mesh/queries/registered/reconcile/preview', None),
      ('GET', '/mesh/queries/inventory', None), ('GET', '/mesh/queries/registered/docs/agents', None),
      ('GET', '/mesh/queries/write/resolve?path=example', None),
      ('POST', '/mesh/queries/write', {"sql": "SELECT id, lang FROM docs ORDER BY id", "format": "ndjson", "path": "file:" + out + "/w1.ndjson"}),
      ('POST', '/mesh/queries/write', {"sql": "SELECT id FROM docs", "format": "nope", "path": "file:" + out + "/w2.x"}),
      ('POST', '/mesh/queries/write/batch', {"queries": [{"sql": "SELECT id FROM docs ORDER BY id", "path": "file:" + out + "/b1.ndjson"}], "format": "ndjson"}),
      ('POST', '/mesh/queries/write', {"sql": "SELECT id, lang FROM docs WHERE lang = 'en' ORDER BY id", "format": "ndjson", "path": "file:" + out + "/w3.ndjson", "register": True, "tableName": "en_docs"}),
      ('SLEEP', '2', None),
      ('FILE', out + '/w1.ndjson', None), ('FILE', out + '/b1.ndjson', None), ('FILE', out + '/w3.ndjson', None),
      ('FILE', os.path.join(work, 'home', '.hitorro', 'driver', 'runtime-tables.json'), None),
      ('FILE', os.path.join(work, 'agent-home', 'runtime-tables', 'agent-us.jsonl'), None),
      ('FILE', os.path.join(work, 'agent-home', 'runtime-tables', 'agent-eu.jsonl'), None),
      ('POST', '/mesh/queries', {"sql": "SELECT * FROM en_docs ORDER BY id", "timeoutMs": 10000}),
      ('GET', '/mesh/queries/registered', None),
      ('DELETE', '/mesh/tables/nope', None), ('DELETE', '/mesh/tables/docs', None), ('GET', '/mesh/tables', None),
      ('GET', '/', None), ('GET', '/ui/', None), ('GET', '/no/such/path', None),
    ]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--driver-cp'); ap.add_argument('--agent-cp'); ap.add_argument('--out'); ap.add_argument('--jar', action='store_true')
    ap.add_argument('--work'); ap.add_argument('--keep', action='store_true')
    a = ap.parse_args()
    work = a.work or tempfile.mkdtemp(prefix='meshgold-')
    shutil.rmtree(work, ignore_errors=True); os.makedirs(work)
    work = os.path.realpath(work)   # macOS: /var -> /private/var, as the JVM reports it
    os.makedirs(os.path.join(work, 'out'))
    procs = []; nats = 'meshgold-nats-' + str(os.getpid())
    np = free_port()
    env = dict(os.environ, DOCKER_HOST='unix:///Users/chris/.rd/docker.sock')
    subprocess.run(['docker', 'run', '-d', '--rm', '--name', nats, '-p', f'{np}:4222', 'nats:2.10', '-js'], check=True, env=env, stdout=subprocess.DEVNULL)
    def java(cp, main_cls, args, log):
        cmd = ['java', '-Xmx768m', '-Duser.home=' + os.path.join(work, 'home'), '-Dhitorro.agent.home=' + os.path.join(work, 'agent-home')] + (['-jar', cp] if (cp.endswith('.jar') and os.pathsep not in cp) else ['-cp', cp, main_cls]) + args
        p = subprocess.Popen(cmd, stdout=open(log, 'w'), stderr=subprocess.STDOUT, cwd=work)
        procs.append(p); return p
    try:
        tdir = os.path.join(work, 'types'); os.makedirs(tdir)
        json.dump(TYPE, open(os.path.join(tdir, 'docs.json'), 'w'))
        agent_ports = {}
        for pk, rows in ROWS.items():
            f = os.path.join(work, f'docs-{pk}.ndjson')
            with open(f, 'w') as fh:
                for r in rows: fh.write(json.dumps(r, ensure_ascii=False) + '\n')
            ap_ = free_port(); agent_ports[pk] = ap_
            java(a.agent_cp, 'com.hitorro.mesh.agent.app.MeshAgentApplication', [
                f'--server.port={ap_}', f'--hitorro.mesh.agent.id=agent-{pk}', f'--hitorro.mesh.agent.nats-url=nats://127.0.0.1:{np}',
                '--hitorro.mesh.agent.capabilities[0]=jvssql', f'--hitorro.mesh.agent.capabilities[1]=partition:docs:{pk}',
                '--hitorro.mesh.agent.tables[0].name=docs', f'--hitorro.mesh.agent.tables[0].partition-key={pk}',
                f'--hitorro.mesh.agent.tables[0].type-json-resource=file:{tdir}/docs.json',
                f'--hitorro.mesh.agent.tables[0].ndjson-file=file://{f}'], os.path.join(work, f'agent-{pk}.log'))
        dp = free_port()
        java(a.driver_cp, 'com.hitorro.mesh.driver.app.MeshDriverApplication', [
            f'--server.port={dp}', f'--hitorro.mesh.driver.nats-url=nats://127.0.0.1:{np}',
            '--hitorro.mesh.datasets.auto-register=false', '--hitorro.fleet.health.enabled=false',
            '--hitorro.mesh.runtime.reconcile.enabled=false',
            f'--hitorro.mesh.schedule.home={work}/schedules', f'--hitorro.pipelines.home={work}/pipelines'],
            os.path.join(work, 'driver.log'))
        base = f'http://127.0.0.1:{dp}'
        ok = wait_up(base + '/actuator/health') and all(wait_up(f'http://127.0.0.1:{p}/actuator/health') for p in agent_ports.values())
        if not ok:
            print('cluster did not come up; logs in', work, file=sys.stderr); sys.exit(2)
        # wait for both agents to be live at the driver
        for _ in range(60):
            st, _, b = http('GET', base + '/mesh/agents')
            if st == 200 and b.count('agent-') >= 2: break
            time.sleep(1)
        time.sleep(3)
        records = []
        subst = {work: '<WORK>', str(dp): '<DPORT>', str(np): '<NPORT>'}
        for p in agent_ports.values(): subst[str(p)] = '<APORT>'
        for i, (m, path, body) in enumerate(requests_list(work)):
            if m == 'SLEEP':
                time.sleep(int(path)); continue
            if m == 'SSE':
                st, ct, b = http('GET', base + path, accept='text/event-stream', timeout=20)
            elif m == 'PUTTEXT':
                st, ct, b = http('PUT', base + path, body, ctype='text/plain')
            elif m == 'FILE':
                st, ct, b = (0, 'file', open(path).read()) if os.path.exists(path) else (0, 'file', '<missing>')
            else:
                st, ct, b = http(m, base + path, body)
            for k, v in subst.items(): b = repl(b, k, v)
            rb = body if isinstance(body, (str, type(None))) else json.dumps(body)
            rq = f"{m} {path}"
            for k, v in subst.items():
                rq = repl(rq, k, v)
                if rb is not None: rb = repl(rb, k, v)
            records.append({"i": i, "req": rq, "body": rb, "status": st, "ctype": ct, "resp": b})
        # agent-app endpoints
        for pk, p in agent_ports.items():
            for path in ['/actuator/health', '/actuator/info', '/no/such']:
                st, ct, b = http('GET', f'http://127.0.0.1:{p}{path}')
                records.append({"i": len(records), "req": f"AGENT GET {path}", "body": None, "status": st, "ctype": ct, "resp": b})
        with open(a.out, 'w') as fh:
            for r in records: fh.write(json.dumps(r, ensure_ascii=False) + '\n')
        print('wrote', len(records), 'records to', a.out, '; work', work)
    finally:
        for p in procs: p.terminate()
        for p in procs:
            try: p.wait(15)
            except Exception: p.kill()
        subprocess.run(['docker', 'rm', '-f', nats], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not a.keep and not a.work: shutil.rmtree(work, ignore_errors=True)

if __name__ == '__main__': main()
