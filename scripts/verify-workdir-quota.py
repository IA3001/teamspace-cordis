#!/usr/bin/env python3
"""Exercise XFS quota registration using isolated files and a fake command runner."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path
from types import SimpleNamespace

MODULE_PATH = Path(__file__).resolve().parents[1] / 'deploy' / 'teamspace-workdir-quota.py'
SPEC = importlib.util.spec_from_file_location('workdir_quota', MODULE_PATH)
assert SPEC and SPEC.loader
quota = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(quota)


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f'✓ {message}')


def main() -> None:
    with tempfile.TemporaryDirectory(prefix='workdir-quota-verify-') as directory:
        base = Path(directory)
        root = base / 'workdirs'
        root.mkdir()
        config = base / 'quota.conf'
        config.write_text(
            f'workdirs_root={root}\nservice_user=teamspace\nsoft_limit=700m\n'
            'hard_limit=768m\nmin_project_id=52000\nmax_project_id=52002\n', encoding='utf-8')
        projects = base / 'projects'
        projid = base / 'projid'
        commands: list[tuple[str, ...]] = []

        def runner(*args: str) -> str:
            commands.append(args)
            return 'xfs rw,relatime,prjquota' if args[0] == 'findmnt' else ''

        owner = SimpleNamespace(pw_uid=1000, pw_gid=1000)
        target = root / 'a_analyst'
        quota.ensure('a_analyst', config_path=config, projects_path=projects, projid_path=projid,
                     command_runner=runner, user_lookup=lambda _name: owner,
                     chown=lambda *_args: None, chmod=lambda *_args: None, require_root_config=False)
        first_projects = projects.read_text(encoding='utf-8').splitlines()
        first_projid = projid.read_text(encoding='utf-8').splitlines()
        check(target.is_dir(), 'creates only the per-Agent directory beneath the configured workdir root')
        check(len(first_projects) == len(first_projid) == 1 and first_projects[0].endswith(f':{target}')
              and first_projid[0].split(':', 1)[1] == first_projects[0].split(':', 1)[0],
              'allocates matching project and project-name mappings')
        check(any(args[0] == 'xfs_quota' and 'project -s' in args[3] for args in commands)
              and any(args[0] == 'xfs_quota' and 'bsoft=700m bhard=768m' in args[3] for args in commands),
              'initializes XFS project membership and applies the configured soft/hard limits')

        command_count = len(commands)
        quota.ensure('a_analyst', config_path=config, projects_path=projects, projid_path=projid,
                     command_runner=runner, user_lookup=lambda _name: owner,
                     chown=lambda *_args: None, chmod=lambda *_args: None, require_root_config=False)
        check(projects.read_text(encoding='utf-8').splitlines() == first_projects
              and projid.read_text(encoding='utf-8').splitlines() == first_projid
              and len(commands) == command_count + 3,
              'repeated registration is idempotent and reasserts XFS limits')

        bad_root = base / 'bad-workdirs'
        bad_root.mkdir()
        bad_config = base / 'bad-quota.conf'
        bad_config.write_text(config.read_text(encoding='utf-8').replace(str(root), str(bad_root)), encoding='utf-8')
        try:
            quota.ensure('a_denied', config_path=bad_config, projects_path=base / 'bad-projects',
                         projid_path=base / 'bad-projid', command_runner=lambda *_args: 'ext4 rw',
                         user_lookup=lambda _name: owner, chown=lambda *_args: None,
                         chmod=lambda *_args: None, require_root_config=False)
            raise AssertionError('non-XFS root was accepted')
        except RuntimeError as error:
            check('XFS with project quota' in str(error) and not (bad_root / 'a_denied').exists(),
                  'rejects a non-XFS root before creating an Agent directory')

        conflict_projects = base / 'conflict-projects'
        conflict_projid = base / 'conflict-projid'
        conflict_projects.write_text(f'52000:{target}\n', encoding='utf-8')
        conflict_projid.write_text('other-agent:52000\n', encoding='utf-8')
        try:
            quota.ensure('a_analyst', config_path=config, projects_path=conflict_projects,
                         projid_path=conflict_projid, command_runner=runner,
                         user_lookup=lambda _name: owner, chown=lambda *_args: None,
                         chmod=lambda *_args: None, require_root_config=False)
            raise AssertionError('conflicting project mappings were accepted')
        except RuntimeError as error:
            check('mappings conflict' in str(error), 'fails closed on conflicting project ID/name mappings')

        invalid = False
        try:
            quota.ensure('../escape', config_path=config, projects_path=projects, projid_path=projid,
                         command_runner=runner, user_lookup=lambda _name: owner,
                         chown=lambda *_args: None, chmod=lambda *_args: None, require_root_config=False)
        except RuntimeError as error:
            invalid = 'invalid Agent ID' in str(error)
        check(invalid, 'rejects path traversal in Agent IDs')


if __name__ == '__main__':
    main()
