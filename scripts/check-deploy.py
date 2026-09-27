#!/usr/bin/env python3
"""Exercise the installer with fake Docker/Git; no servers or paid APIs are used."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = str(Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe') if os.name == 'nt' else shutil.which('bash')
COMMIT = '4b0ff693b3ed6aa4f2006162453d32783c011718'


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workbench-deploy-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('deploy.sh', 'compose.gate.yaml', 'compose.gate-network.yaml',
                     'deploy/stack/compose.yaml', 'deploy/stack/compose.https.yaml',
                     'deploy/stack/env.example', 'deploy/stack/Caddyfile.example'):
            dest = self.root / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, dest)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / 'calls'
        for name, body in {
            'docker': '''printf '%s\\n' "$*" >> "$CALL_LOG"
case " $* " in *" pull "*) [[ "${FAIL_PULL:-0}" != 1 ]] || exit 1;; esac
case " $* " in *" up "*) [[ "${FAIL_UP:-0}" != 1 ]] || exit 1;; esac
''',
            'git': f'''printf 'git %s\\n' "$*" >> "$CALL_LOG"
case "$1" in clone) mkdir -p "$3";; esac
case "$*" in *'rev-parse HEAD') printf '%s\\n' "${{FAKE_COMMIT:-{COMMIT}}}";; esac
''',
        }.items():
            path = self.bin / name
            path.write_text('#!/usr/bin/env bash\nset -eu\n' + body, encoding='utf-8', newline='\n')
            path.chmod(0o755)

    def run_script(self, answers='', *args, **overrides):
        env = os.environ.copy()
        # PATH is constructed inside Bash so Git Bash and Linux share the same tests.
        env.update(CALL_LOG=self.log.as_posix(), **overrides)
        result = subprocess.run([BASH, '-c', 'cd "$1"; export PATH="$PWD/bin:$PATH"; shift; bash "$@"',
                                 'test', self.root.as_posix(), (self.root / 'deploy.sh').as_posix(), *args],
                                input=answers.encode('utf-8'), capture_output=True, env=env)
        self.output = (result.stdout + result.stderr).decode('utf-8')
        return result.returncode

    def test_stack_and_repeated_install_preserve_credentials(self):
        password, token = 'Test$# password', 'dummy$token#not-real'
        self.assertEqual(self.run_script(f'1\n{password}\n{token}\n'), 0, self.output)
        env = self.root / 'deploy/stack/.env'
        original = env.read_bytes()
        self.assertIn(f"ADMIN_PASSWORD='{password}'", original.decode())
        self.assertNotIn(password, self.output)
        self.assertNotIn(token, self.log.read_text())
        self.assertEqual(self.run_script('1\n'), 0, self.output)
        self.assertEqual(env.read_bytes(), original)

    def test_interrupted_secret_input_writes_nothing(self):
        self.assertNotEqual(self.run_script('1\npassword\n'), 0)
        self.assertFalse((self.root / 'deploy/stack/.env').exists())

    def test_existing_gate_network_is_used(self):
        self.assertEqual(self.run_script('2\nhttp://gate:8000\ngate_default\n'), 0, self.output)
        calls = self.log.read_text()
        self.assertIn('compose.gate-network.yaml', calls)
        self.assertIn('up -d --no-deps frontend', calls)
        self.assertNotIn('git ', calls)
        self.assertNotIn('build gate', calls)

    def test_localhost_and_injected_urls_rejected(self):
        for url in ['http://localhost:8000', 'http://127.0.0.1:8000', 'http://gate;touch pwned', 'http://user:secret@gate']:
            self.assertNotEqual(self.run_script(f'2\n{url}\n'), 0)
            self.assertFalse((self.root / '.env').exists())

    def test_pull_failure_keeps_old_config(self):
        env = self.root / '.env'
        original = b'WORKBENCH_GATE_URL=http://gate:8000\nWORKBENCH_IMAGE=old:tag\nCUSTOM=keep\n'
        env.write_bytes(original)
        self.assertNotEqual(self.run_script('y\n', 'update', 'v0.1.0-beta.4', FAIL_PULL='1'), 0)
        self.assertEqual(env.read_bytes(), original)
        self.assertNotIn(' up ', self.log.read_text())

    def test_update_preserves_other_fields_and_only_restarts_frontend(self):
        env = self.root / '.env'
        original = b'WORKBENCH_GATE_URL=http://gate:8000\nWORKBENCH_IMAGE=old:tag\nCUSTOM=keep\n'
        env.write_bytes(original)
        self.assertEqual(self.run_script('y\n', 'update', 'v0.1.0-beta.4'), 0, self.output)
        self.assertIn('CUSTOM=keep', env.read_text())
        self.assertNotIn('old:tag', env.read_text())
        self.assertEqual((self.root / '.env.before-update').read_bytes(), original)
        self.assertIn('up -d --no-deps frontend', self.log.read_text())
        self.assertNotIn('build gate', self.log.read_text())

    def test_start_failure_restores_config(self):
        env = self.root / '.env'
        original = b'WORKBENCH_GATE_URL=http://gate:8000\nWORKBENCH_IMAGE=old:tag\n'
        env.write_bytes(original)
        self.assertNotEqual(self.run_script('y\n', 'update', FAIL_UP='1'), 0)
        self.assertEqual(env.read_bytes(), original)

    def test_https_validates_domain_and_keeps_existing_config(self):
        stack = self.root / 'deploy/stack'
        (stack / '.env').write_text('ADMIN_PASSWORD=dummy\nNAI_TOKENS=dummy\n')
        self.assertNotEqual(self.run_script('bad;domain\n', 'https'), 0)
        self.assertFalse((stack / 'Caddyfile').exists())
        self.assertEqual(self.run_script('draw.example.org\n', 'https'), 0, self.output)
        original = (stack / 'Caddyfile').read_bytes()
        self.assertIn(b'draw.example.org', original)
        self.assertEqual(self.run_script('', 'https'), 0, self.output)
        self.assertEqual((stack / 'Caddyfile').read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
