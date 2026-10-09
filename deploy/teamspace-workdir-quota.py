#!/usr/bin/env python3
"""Root-owned, narrow XFS project-quota registrar for Agent workdirs."""
from __future__ import annotations

import fcntl
import hashlib
import os
import pwd
import re
import subprocess
import sys
from pathlib import Path

CONFIG = Path('/etc/teamspace/workdir-quota.conf')
LOCK = Path('/run/lock/teamspace-workdir-quota.lock')
ID_PATTERN = re.compile(r'^[A-Za-z0-9._-]{1,100}$')


def read_config(config_path: Path = CONFIG, *, require_root_owner: bool = True) -> dict[str, str]:
    if config_path.is_symlink():
        raise RuntimeError('quota config must not be a symlink')
    info = config_path.stat()
    if require_root_owner and (info.st_uid != 0 or info.st_mode & 0o022):
        raise RuntimeError('quota config must be root-owned and not group/world writable')
    values: dict[str, str] = {}
    for line in config_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        if not sep:
            raise RuntimeError('invalid quota config line')
        values[key.strip()] = value.strip()
    required = {'workdirs_root', 'service_user', 'soft_limit', 'hard_limit', 'min_project_id', 'max_project_id'}
    if required - values.keys():
        raise RuntimeError('quota config is missing required fields')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,31}', values['service_user']):
        raise RuntimeError('invalid service user in quota config')
    for name in ('soft_limit', 'hard_limit'):
        if not re.fullmatch(r'[1-9][0-9]*[kKmMgGtT]?', values[name]):
            raise RuntimeError(f'invalid {name} in quota config')
    if quota_bytes(values['soft_limit']) > quota_bytes(values['hard_limit']):
        raise RuntimeError('soft_limit must not exceed hard_limit')
    low, high = int(values['min_project_id']), int(values['max_project_id'])
    if low < 1 or high < low or high > 2**31 - 1 or high - low > 1_000_000:
        raise RuntimeError('invalid project ID allocation range')
    return values


def quota_bytes(value: str) -> int:
    suffixes = {'': 1, 'k': 1024, 'm': 1024**2, 'g': 1024**3, 't': 1024**4}
    match = re.fullmatch(r'([1-9][0-9]*)([kKmMgGtT]?)', value)
    if not match:
        raise RuntimeError('invalid quota size')
    return int(match.group(1)) * suffixes[match.group(2).lower()]


def run(*args: str) -> str:
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=30).strip()


def append_mapping(path: Path, line: str) -> None:
    entries = path.read_text(encoding='utf-8').splitlines() if path.exists() else []
    if line not in entries:
        with path.open('a', encoding='utf-8') as file:
            file.write(line + '\n')
            file.flush()
            os.fsync(file.fileno())


def ensure(
    agent_id: str,
    *,
    config_path: Path = CONFIG,
    projects_path: Path = Path('/etc/projects'),
    projid_path: Path = Path('/etc/projid'),
    command_runner=run,
    user_lookup=pwd.getpwnam,
    chown=os.chown,
    chmod=os.chmod,
    require_root_config: bool = True,
) -> None:
    if not ID_PATTERN.fullmatch(agent_id):
        raise RuntimeError('invalid Agent ID')
    cfg = read_config(config_path, require_root_owner=require_root_config)
    root = Path(cfg['workdirs_root']).resolve(strict=True)
    target = root / agent_id
    if target.parent != root or target.is_symlink():
        raise RuntimeError('workdir path is outside configured root')
    mount = command_runner('findmnt', '-n', '-o', 'FSTYPE,OPTIONS', '--target', str(root)).split()
    if len(mount) != 2 or mount[0] != 'xfs' or not ({'prjquota', 'pquota'} & set(mount[1].split(','))):
        raise RuntimeError('configured workdir root is not XFS with project quotas enabled')
    os.makedirs(target, mode=0o700, exist_ok=True)
    if target.is_symlink() or target.resolve(strict=True).parent != root:
        raise RuntimeError('workdir path is not a direct child of the configured root')

    project_name = 'ts-' + hashlib.sha256(agent_id.encode('ascii')).hexdigest()[:24]
    projects = projects_path
    projid = projid_path
    projects_entries = projects.read_text(encoding='utf-8').splitlines() if projects.exists() else []
    projid_entries = projid.read_text(encoding='utf-8').splitlines() if projid.exists() else []
    path_matches = [line.split(':', 1)[0] for line in projects_entries if ':' in line and line.split(':', 1)[1] == str(target)]
    name_matches = [line.split(':', 1)[1] for line in projid_entries if ':' in line and line.split(':', 1)[0] == project_name]
    used_ids = {int(line.split(':', 1)[0]) for line in projects_entries if ':' in line and line.split(':', 1)[0].isdigit()}
    used_ids.update(int(line.split(':', 1)[1]) for line in projid_entries
                    if ':' in line and line.split(':', 1)[1].isdigit())
    if path_matches or name_matches:
        if len(path_matches) != 1 or len(name_matches) != 1 or path_matches[0] != name_matches[0]:
            raise RuntimeError('existing project quota mappings conflict')
        project_id = int(path_matches[0])
    else:
        low, high = int(cfg['min_project_id']), int(cfg['max_project_id'])
        project_id = next((candidate for candidate in range(low, high + 1) if candidate not in used_ids), 0)
        if not project_id:
            raise RuntimeError('project ID allocation range is exhausted')
        project_line = f'{project_id}:{target}'
        name_line = f'{project_name}:{project_id}'
        append_mapping(projects, project_line)
        try:
            append_mapping(projid, name_line)
        except Exception:
            # These system files cannot be atomically replaced together. Roll back
            # the first append so a transient second-file failure can be retried.
            remaining = [line for line in projects.read_text(encoding='utf-8').splitlines()
                         if line != project_line]
            projects.write_text(('\n'.join(remaining) + '\n') if remaining else '', encoding='utf-8')
            with projects.open('rb') as file:
                os.fsync(file.fileno())
            raise

    user = user_lookup(cfg['service_user'])
    chown(target, user.pw_uid, user.pw_gid)
    chmod(target, 0o700)
    command_runner('xfs_quota', '-x', '-c', f'project -s {project_name}', str(root))
    command_runner('xfs_quota', '-x', '-c',
                   f"limit -p bsoft={cfg['soft_limit']} bhard={cfg['hard_limit']} {project_name}", str(root))


def main() -> int:
    if os.geteuid() != 0:
        print('must run as root', file=sys.stderr)
        return 1
    if len(sys.argv) != 3 or sys.argv[1] != 'ensure':
        print('usage: teamspace-workdir-quota ensure AGENT_ID', file=sys.stderr)
        return 2
    try:
        LOCK.parent.mkdir(parents=True, exist_ok=True)
        with LOCK.open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            ensure(sys.argv[2])
        return 0
    except Exception as error:
        detail = getattr(error, 'stderr', None)
        print(str(detail or error).strip(), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
