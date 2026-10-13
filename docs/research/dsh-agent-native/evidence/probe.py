import pathlib,tempfile,shutil,subprocess,json,time,os
import argparse
p=argparse.ArgumentParser(description='Run original DSH check scripts against disposable fixtures; no API calls.')
p.add_argument('--source',type=pathlib.Path,required=True)
p.add_argument('--dependencies',type=pathlib.Path,required=True)
p.add_argument('--output',type=pathlib.Path,required=True)
a=p.parse_args()
source=a.source.resolve();deps=a.dependencies.resolve();results=[]
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
if sha!='d743267388641bc76f17c45ce8b4c231aed1d32c': raise SystemExit('Source must be the pinned DSH checkout.')
root=pathlib.Path(tempfile.mkdtemp(prefix='dsh-gate-probe-'))
try:
 shutil.copytree(source/'scripts',root/'scripts');(root/'node_modules').symlink_to(deps,target_is_directory=True)
 (root/'package.json').write_text('{"type":"module"}')
 for d in ['docs','packages/demo/service/src','packages/bundle/probe','.agents/notes']:(root/d).mkdir(parents=True,exist_ok=True)
 def run(name,script,expected):
  start=time.monotonic();p=subprocess.run(['node','--experimental-strip-types',str(root/'scripts'/script)],cwd=root,text=True,capture_output=True,timeout=30)
  results.append({'name':name,'script':script,'expected_exit':expected,'actual_exit':p.returncode,'duration_ms':round((time.monotonic()-start)*1000),'stdout':p.stdout,'stderr':p.stderr})
  assert p.returncode==expected,(name,p.stdout,p.stderr)
 (root/'scripts/doc-budgets.manifest.json').write_text('{"README.md":4}')
 (root/'README.md').write_text('# Demo\n\nShort.\n');run('budget-valid','verify-doc-budgets.ts',0)
 (root/'README.md').write_text('# Demo\n\nToo many words added to standing instructions.\n');run('budget-overflow','verify-doc-budgets.ts',1)
 (root/'README.md').write_text('# Demo\n')
 (root/'docs/demo.md').write_text('# Demo\n\n[valid](target.md#good)\n');(root/'docs/target.md').write_text('# Good\n');run('links-valid','verify-md-links.ts',0)
 (root/'docs/demo.md').write_text('# Demo\n\n[broken](target.md#missing)\n');run('links-broken-anchor','verify-md-links.ts',1)
 (root/'docs/demo.md').write_text('# Demo\n\n```ts type-equiv\ninterface Sample { value: string }\n```\n')
 (root/'packages/demo/service/src/index.ts').write_text('export interface Sample { value: string }\n')
 (root/'scripts/type-equiv.manifest.json').write_text(json.dumps({'entries':[{'doc':'docs/demo.md','symbol':'Sample','source':'packages/demo/service/src/index.ts'}]}));run('type-equiv-valid','verify-type-equiv.ts',0)
 (root/'docs/demo.md').write_text('# Demo\n\n```ts type-equiv\ninterface Sample { value: number }\n```\n');run('type-equiv-stale-doc','verify-type-equiv.ts',1)
 (root/'packages/bundle/probe/cordis.patch.yml').write_text('- id: probe\n  name: probe\n  config:\n    apiKeyEnv: TEST_KEY\n');run('config-source-valid','verify-config-source-ownership.ts',0)
 (root/'packages/bundle/probe/cordis.patch.yml').write_text('- id: probe\n  name: probe\n  config:\n    apiKey: !!js process.env.TEST_KEY\n');run('config-source-forbidden-inline','verify-config-source-ownership.ts',1)
 a.output.write_text(json.dumps(results,indent=2));print(json.dumps([{k:r[k] for k in ['name','actual_exit','duration_ms']} for r in results]));shutil.rmtree(root)
finally:
 shutil.rmtree(root,ignore_errors=True)
