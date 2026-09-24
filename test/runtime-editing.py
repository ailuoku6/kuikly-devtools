#!/usr/bin/env python3
"""Compile/runtime regression against a local Kuikly checkout; writes only to a temp directory.
Usage: python3 test/runtime-editing.py /path/to/KuiklyUI
Requires the existing instrumentor fat jar (contains the Kotlin compiler and stdlib).
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

repo = pathlib.Path(__file__).resolve().parents[1]
core = pathlib.Path(sys.argv[1]).resolve()
jar = repo / 'gradle/libs/kuikly-devtools-instrumentor.jar'

with tempfile.TemporaryDirectory(prefix='kuikly-editing-') as tmp:
    work = pathlib.Path(tmp)

    def run(args):
        result = subprocess.run([str(arg) for arg in args], cwd=repo, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if result.returncode:
            print(result.stdout)
            raise SystemExit(result.returncode)
        return result.stdout

    def compile_kotlin(sources, destination, extra=()):
        run(['java', '-cp', jar, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
             '-classpath', jar, '-d', destination, *extra, *sources])

    instrumentor = work / 'instrumentor'
    compile_kotlin(sorted((repo / 'instrumentor/src/main/kotlin').rglob('*.kt')), instrumentor)
    fixtures = work / 'fixtures'
    fixtures.mkdir()
    shutil.copy(repo / 'test/runtime/EditingFixture.kt', fixtures)
    run(['java', '-cp', f'{instrumentor}:{jar}', 'com.ailuoku6.kuikly.devtools.instrumentor.MainKt', fixtures])
    config = work / 'KDevtoolsConfig.kt'
    config.write_text('package com.ailuoku6.kuikly.devtools\ninternal object KDevtoolsConfig { const val ENABLED = true; const val HOST = "localhost"; const val PORT = 8866; const val SAMPLE_MS = 500 }')
    sources = [p for part in ['core/src/commonMain', 'core/src/jvmMain', 'core-annotations/src/commonMain'] for p in (core / part).rglob('*.kt')]
    if not sources:
        raise SystemExit('No Kuikly source files found')
    sources += [p for part in ['runtime/kotlin', 'runtime/jvmDelegate'] for p in (repo / part).rglob('*.kt')]
    sources += [config, repo / 'test/runtime/EditingTest.kt', fixtures / 'EditingFixture.kt']
    runtime = work / 'runtime.jar'
    compile_kotlin(sources, runtime, ['-Xmulti-platform'])
    print(run(['java', '-cp', f'{runtime}:{jar}', 'com.ailuoku6.kuikly.devtools.EditingTestKt']).strip())
