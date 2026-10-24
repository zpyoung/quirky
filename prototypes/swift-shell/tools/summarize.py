#!/usr/bin/env python3
"""Turns results/results.json into the median tables used in results/results.md."""
import json, os, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, '..', 'results', 'results.json')))
LABEL = {
    'a': '(a) idle, sidebar only',
    'b': '(b) 2 panes, empty shells',
    'c': '(c) 2 panes after seq 1 10000',
    'd': '(d) 4 panes after seq 1 10000',
    'e': '(e) = (c) + full daemon UI in WKWebView',
    'e-blank': '(e-blank) = (c) + WKWebView on about:blank',
}


def med(runs, phase, key):
    vals = [r[phase][key] for r in runs if phase in r]
    return round(statistics.median(vals), 1) if vals else None


def row(label, runs, phase):
    return (f"| {label} | {med(runs, phase, 'app_fp')} | {med(runs, phase, 'webkit_fp')} | "
            f"{med(runs, phase, 'daemon_fp')} | {med(runs, phase, 'pty_host_fp')} | "
            f"{med(runs, phase, 'shell_total_fp')} | {med(runs, phase, 'quirky_total_fp')} | "
            f"{med(runs, phase, 'shells_fp')} |")


out = []
for engine in ['ghostty', 'swiftterm']:
    out.append(f"### {engine}\n")
    out.append('| workload | app | WebKit procs | daemon | PTY host | shell (app+WebKit) | Quirky total | shells (not in totals) |')
    out.append('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for w in ['a', 'b', 'c', 'd']:
        runs = data.get(f'{engine}/{w}')
        if runs:
            out.append(row(LABEL[w], runs, 'base'))
    for w in ['e', 'e-blank']:
        runs = data.get(f'{engine}/{w}')
        if runs:
            out.append(row(LABEL[w].replace('(e', '(e').split(' = ')[0] + ' base', runs, 'base') if False else row(f"{LABEL[w]}", runs, 'web'))
    out.append('')
print('\n'.join(out))
