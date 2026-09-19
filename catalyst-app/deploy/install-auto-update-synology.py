#!/usr/bin/env python3
"""Install the NAS updater and a native DSM task; run once with sudo."""
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys

STAGE = Path(__file__).resolve().parent
DEST = Path('/usr/local/lib/catalyst-coach')
NAME = 'Update Catalyst Coach'
COMMAND = '/bin/bash /usr/local/lib/catalyst-coach/auto-update-synology.sh'
API = '/usr/syno/bin/synowebapi'


class ProgressOutput:
    """Show progress in the SSH terminal while retaining the installation log."""
    def __init__(self, terminal, log):
        self.terminal = terminal
        self.log = log

    def write(self, text):
        self.terminal.write(text)
        return self.log.write(text)

    def flush(self):
        self.terminal.flush()
        self.log.flush()


def api(method, version=4, root=False, **params):
    args = [API, '--exec', 'api=SYNO.Core.TaskScheduler' + ('.Root' if root else ''),
            f'method={method}', f'version={version}']
    args += [f'{key}={json.dumps(value, separators=(",", ":"))}' for key, value in params.items()]
    result = subprocess.run(args, text=True, capture_output=True)
    # synowebapi may prepend an informational line to its JSON response.
    for index, char in enumerate(result.stdout):
        if char != '{':
            continue
        try:
            reply, _ = json.JSONDecoder().raw_decode(result.stdout[index:])
        except ValueError:
            continue
        if isinstance(reply, dict) and 'success' in reply:
            if not reply['success']:
                raise RuntimeError(f'DSM {method} failed: {reply.get("error")}')
            return reply.get('data', {})
    raise RuntimeError(f'DSM {method} returned no result: {result.stderr[-1000:]} {result.stdout[-1000:]}')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run this installer with sudo.')
    account = pwd.getpwnam('cooljoe')
    log = STAGE / 'setup.log'
    log.touch(mode=0o600)
    os.chown(log, account.pw_uid, account.pw_gid)
    # Keep a readable record so installation can be verified over key-based SSH.
    with log.open('w', buffering=1) as output:
        original = sys.stdout
        sys.stdout = ProgressOutput(original, output)
        try:
            print('Preparing native DSM task.', flush=True)
            tasks = api('list', version=3).get('tasks', [])
            matches = [task for task in tasks if task.get('name') == NAME]
            if len(matches) > 1:
                raise RuntimeError('More than one matching task exists; refusing to create another.')
            task_id = matches[0]['id'] if matches else -1
            template = api('get', id=task_id, real_owner='root', **({'type': 'script'} if task_id == -1 else {}))
            if task_id != -1 and (template.get('owner') != 'root' or template.get('extra', {}).get('script') != COMMAND):
                raise RuntimeError('An unrelated task has this name; refusing to overwrite it.')
            DEST.mkdir(parents=True, exist_ok=True)
            os.chown(DEST, 0, 0)
            DEST.chmod(0o755)
            target = DEST / 'auto-update-synology.sh'
            shutil.copyfile(STAGE / target.name, target)
            os.chown(target, 0, 0)
            target.chmod(0o700)
            schedule = template.get('schedule', {}).copy()
            schedule.update(date_type=0, repeat_date=1001, monthly_week=[], hour=0,
                            minute=0, repeat_hour=0, repeat_min=15, last_work_hour=23)
            extra = template.get('extra', {}).copy()
            extra.update(script=COMMAND, notify_enable=False, notify_mail='', notify_if_error=True)
            params = dict(name=NAME, owner='root', enable=True, schedule=schedule, extra=extra)
            if task_id == -1:
                params['type'] = 'script'
            else:
                params['id'] = task_id
            print(api('create' if task_id == -1 else 'set', root=True, **params), flush=True)
            print(subprocess.check_output(['/usr/syno/bin/synoschedtask', '--get', 'owner=root'], text=True), flush=True)
            print('Testing updater now.', flush=True)
            with subprocess.Popen(['/bin/bash', str(target)], stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, bufsize=1) as process:
                for line in process.stdout:
                    print(line, end='', flush=True)
                returncode = process.wait()
            print(f'Updater exit: {returncode}', flush=True)
            if returncode:
                raise RuntimeError('Updater test failed; inspect setup.log.')
            print('SETUP COMPLETE', flush=True)
        except Exception as error:
            print(f'SETUP FAILED: {error}', flush=True)
            raise
        finally:
            sys.stdout = original
    print(f'Automatic updates configured. Installation log: {log}')


if __name__ == '__main__':
    main()
