#!/usr/bin/env python3
"""Memory workloads (a)-(e) for the Swift shell against the real quirkyd and PTY host.

usage: measure.py <engine: ghostty|swiftterm|all> [runs=3] [settle=25] [workloads=a,b,c,d,e,e-blank]

Uses `footprint -p <pid>` phys_footprint like research/memory-probe/measure.py. Each run starts a
fresh QUIRKY_HOME under /tmp, a fresh daemon, and the app, and kills them all afterwards.
"""
import ctypes, json, os, re, signal, statistics, subprocess, sys, tempfile, time, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, '..', '.build', 'release', 'QuirkyShell')
TREE = os.environ.get('QUIRKY_TREE', '/Users/zpyoung/orca/workspaces/quirky/architecture')
DAEMON = os.path.join(TREE, 'packages/daemon/src/main.ts')
BUN = os.path.expanduser('~/.bun/bin/bun')
REPO = '/tmp/qswift-repo'


def ps_rows():
    out = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss=,comm='], capture_output=True, text=True).stdout
    rows = {}
    for line in out.splitlines():
        p = line.split(None, 3)
        if len(p) == 4:
            rows[int(p[0])] = (int(p[1]), int(p[2]), p[3])
    return rows


def descendants(rows, root):
    seen = {root}
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _, _) in rows.items():
            if ppid in seen and pid not in seen:
                seen.add(pid)
                changed = True
    return seen


def footprint(pid):
    r = subprocess.run(['footprint', '-p', str(pid)], capture_output=True, text=True)
    m = re.search(r'Footprint:\s*([\d.]+)\s*([KMG]B)', r.stdout)
    if not m:
        return None
    v = float(m.group(1))
    return v / 1024 if m.group(2) == 'KB' else v * 1024 if m.group(2) == 'GB' else v


_libsystem = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
_responsible = _libsystem.responsibility_get_pid_responsible_for_pid
_responsible.argtypes = [ctypes.c_int]
_responsible.restype = ctypes.c_int


def webkit_pids(rows, owner, before=frozenset()):
    """WebKit XPC services created after `before` whose responsible process is `owner`'s.

    They are not children of the app, and a bare binary's responsible process is its launching
    ancestor, so the owner's responsible pid is compared rather than the owner itself.
    """
    responsible = _responsible(owner)
    return {p for p, (_, _, c) in rows.items()
            if 'com.apple.WebKit' in c and p not in before and _responsible(p) == responsible}


def snapshot(app_pid, daemon_pid, pty_pid, webkit_before):
    rows = ps_rows()
    procs = []

    def add(role, pid):
        if pid not in rows:
            return
        _, rss, comm = rows[pid]
        procs.append(dict(role=role, pid=pid, name=os.path.basename(comm), rss=round(rss / 1024, 1),
                          fp=footprint(pid)))

    add('app', app_pid)
    for pid in sorted(webkit_pids(rows, app_pid, webkit_before)):
        add('webkit', pid)
    add('daemon', daemon_pid)
    add('pty-host', pty_pid)
    if pty_pid in rows:
        for pid in sorted(descendants(rows, pty_pid) - {pty_pid}):
            add('shell', pid)

    def total(*roles):
        return round(sum(x['fp'] or 0 for x in procs if x['role'] in roles), 1)

    return dict(procs=procs,
                app_fp=total('app'), webkit_fp=total('webkit'), daemon_fp=total('daemon'),
                pty_host_fp=total('pty-host'), shells_fp=total('shell'),
                shell_total_fp=total('app', 'webkit'),
                quirky_total_fp=total('app', 'webkit', 'daemon', 'pty-host'))


def run_workload(engine, name, panes, fill, web, settle):
    home = tempfile.mkdtemp(prefix='qswift-', dir='/tmp')
    env = dict(os.environ, QUIRKY_HOME=home)
    started = []
    results = {}
    try:
        daemon = subprocess.Popen([BUN, DAEMON], env=env, cwd=TREE, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, start_new_session=True)
        started.append(daemon.pid)
        runtime = os.path.join(home, 'runtime.json')
        for _ in range(100):
            if os.path.exists(runtime):
                break
            time.sleep(0.2)
        daemon_pid = json.load(open(runtime))['pid']
        time.sleep(1.5)
        pty_pid = int(open(os.path.join(home, 'pty.pid')).read().strip())
        webkit_before = {p for p, (_, _, c) in ps_rows().items() if 'com.apple.WebKit' in c}
        app_env = dict(env, QSWIFT_PANES=str(panes), QSWIFT_ADD_REPO=REPO, QSWIFT_ENGINE=engine,
                       QSWIFT_FILL=str(fill))
        if web == 'blank':
            app_env['QSWIFT_WEB_URL'] = 'about:blank'
        app = subprocess.Popen([APP], env=app_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               start_new_session=True)
        started.append(app.pid)
        time.sleep(settle)
        results['base'] = snapshot(app.pid, daemon_pid, pty_pid, webkit_before)
        if web:
            os.kill(app.pid, signal.SIGUSR1)
            time.sleep(settle)
            results['web'] = snapshot(app.pid, daemon_pid, pty_pid, webkit_before)
    finally:
        rows = ps_rows()
        victims = set()
        for pid in started:
            if pid in rows:
                victims |= descendants(rows, pid)
        try:
            pty = int(open(os.path.join(home, 'pty.pid')).read().strip())
            victims |= descendants(rows, pty)
        except Exception:
            pass
        wk_new = set()
        for pid in started:
            wk_new |= webkit_pids(rows, pid, locals().get('webkit_before', frozenset()))
        for pid in sorted(victims, reverse=True):
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(3)
        rows = ps_rows()
        for pid in victims | wk_new:
            if pid in rows:
                try:
                    os.kill(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        shutil.rmtree(home, ignore_errors=True)
    return results


WORKLOADS = {
    'a': dict(panes=0, fill=0, web=None),
    'b': dict(panes=2, fill=0, web=None),
    'c': dict(panes=2, fill=10000, web=None),
    'd': dict(panes=4, fill=10000, web=None),
    'e': dict(panes=2, fill=10000, web='ui'),
    'e-blank': dict(panes=2, fill=10000, web='blank'),
}


def main():
    engines = ['ghostty', 'swiftterm'] if sys.argv[1] == 'all' else [sys.argv[1]]
    runs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    settle = int(sys.argv[3]) if len(sys.argv) > 3 else 25
    wanted = (sys.argv[4] if len(sys.argv) > 4 else 'a,b,c,d,e,e-blank').split(',')
    out_path = os.path.join(HERE, '..', 'results', 'results.json')
    data = json.load(open(out_path)) if os.path.exists(out_path) else {}
    for engine in engines:
        for w in wanted:
            cfg = WORKLOADS[w]
            for i in range(runs):
                r = run_workload(engine, w, cfg['panes'], cfg['fill'], cfg['web'], settle)
                key = f'{engine}/{w}'
                data.setdefault(key, []).append(r)
                b = r['base']
                line = f"{key} run{i + 1}: app {b['app_fp']} webkit {b['webkit_fp']} daemon {b['daemon_fp']} pty {b['pty_host_fp']}"
                if 'web' in r:
                    x = r['web']
                    line += f" | +web app {x['app_fp']} webkit {x['webkit_fp']} daemon {x['daemon_fp']}"
                print(line, flush=True)
                json.dump(data, open(out_path, 'w'), indent=1)


if __name__ == '__main__':
    main()
