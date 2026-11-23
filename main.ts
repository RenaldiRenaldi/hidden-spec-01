// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\') || !p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')) return false;
  const root = realpathSync('.');
  let probe = resolve(root, p);
  while (true) {
    try {
      const actual = realpathSync(probe);
      return actual === root || actual.startsWith(root + sep);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = ((tree: Tree) => void) & { move?: [string, string] };

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}


interface FileText { lines: string[]; br: string; final: boolean }
function fileText(text: string): FileText {
  const n=text.indexOf('\n'), br=n>0&&text[n-1]==='\r'?'\r\n':'\n';
  if(text==='') return {lines:[],br,final:false};
  const lines=text.split(br), final=text.endsWith(br); if(final) lines.pop(); return {lines,br,final};
}
function render(f:FileText):string{return f.lines.length?f.lines.join(f.br)+(f.final?f.br:''):'';}
let temporarySequence=0;
function atomicWrite(path:string,text:string):void{
 mkdirSync(dirname(path),{recursive:true});
 const temporary=`${path}.mend-tmp-${process.pid}-${temporarySequence++}`;
 try{writeFileSync(temporary,text,{flag:'wx'});renameSync(temporary,path);}catch(error){rmSync(temporary,{force:true});throw error;}
}
const trail=(s:string)=>s.replace(/[ \t]+$/g,'');
const both=(s:string)=>s.replace(/^[ \t]+|[ \t]+$/g,'');
function eq(a:string,b:string,t:number){return t===0?a===b:t===1?trail(a)===trail(b):both(a)===both(b);}
function occurrences(lines:string[],old:string[],strict:boolean,start=0,endOnly=false):{tier:number,at:number[]}|null{
 for(let tier=0;tier<=(strict?0:2);tier++){const at:number[]=[];for(let i=start;i+old.length<=lines.length;i++)if((!endOnly||i+old.length===lines.length)&&old.every((v,k)=>eq(lines[i+k]!,v,tier)))at.push(i);if(at.length)return{tier,at};}return null;
}
function replaceLines(f:FileText,at:number,old:string[],neu:string[],tier:number,context:number[]=[]){
 const F=(f.lines[at]??'').match(/^[ \t]*/)![0],P=(old[0]??'').match(/^[ \t]*/)![0];
 const out=neu.map((line,i)=>{if(context[i]!==undefined)return f.lines[at+context[i]!]!;return tier===2&&!blank(line)&&line.startsWith(P)?F+line.slice(P.length):line;});
 f.lines.splice(at,old.length,...out);
}
interface Hunk{a:number;old:string[];neu:string[];context:number[];noBreak:boolean;lastKind:string}
interface USection{oldPath:string|null;newPath:string|null;create:boolean;del:boolean;hunks:Hunk[]}
function unPath(s:string):string|null{let p=s.slice(4).split('\t')[0]!.trim();if(p==='/dev/null')return null;if(p.startsWith('a/')||p.startsWith('b/'))p=p.slice(2);return p;}
function unifiedEdits(lines:string[],strict:boolean):Edit[]{
 const sections:USection[]=[];let sec:USection|null=null,h:Hunk|null=null;
 for(let i=0;i<lines.length;i++){
  const l=lines[i]!;
  if(sec&&(sec.del||sec.newPath===null)&&!l.startsWith('diff --git ')&&!(l.startsWith('--- ')&&(lines[i+1]??'').startsWith('+++ ')))continue;
  if(h){
   if(!(l===''||l.startsWith(' ')||l.startsWith('-')||l.startsWith('+')||l.startsWith('\\'))){while(h.context[h.neu.length-1]===h.old.length-1&&h.old.at(-1)===''){h.old.pop();h.neu.pop();h.context.pop();}}
   if(l.startsWith('diff --git ')||l.startsWith('@@')||(l.startsWith('--- ')&&(lines[i+1]??'').startsWith('+++ ')))h=null;
   else if(l===''||l.startsWith(' ')||l.startsWith('-')||l.startsWith('+')||l.startsWith('\\')){
    if(l.startsWith('\\')){if(h.lastKind==='context'||h.lastKind==='add')h.noBreak=true;continue;}const text=l===''?'':l.slice(1);
    if(l.startsWith('-')){h.old.push(text);h.lastKind='delete';}else if(l.startsWith('+')){h.neu.push(text);h.noBreak=false;h.lastKind='add';}else{h.context[h.neu.length]=h.old.length;h.old.push(text);h.neu.push(text);h.noBreak=false;h.lastKind='context';}continue;
   }else h=null;
  }
  if(l.startsWith('diff --git ')){
   const m=/^diff --git a\/(.+) b\/(.+)$/.exec(l);if(!m)throw new Exit2(`error: parse ${i+1}`);
   sec={oldPath:m[1]!,newPath:m[2]!,create:false,del:false,hunks:[]};sections.push(sec);continue;
  }
  if(l.startsWith('--- ')){
   if(!(lines[i+1]??'').startsWith('+++ '))throw new Exit2(`error: parse ${i+2}`);
   const oldPath=unPath(l),newPath=unPath(lines[i+1]!);
   if(!sec||sec.hunks.length){sec={oldPath,newPath,create:false,del:false,hunks:[]};sections.push(sec);}else{sec.oldPath=oldPath;sec.newPath=newPath;}i++;continue;
  }
  if(l.startsWith('@@')){
   const m=/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);if(!m||!sec)throw new Exit2(`error: parse ${i+1}`);
   h={a:Number(m[1]),old:[],neu:[],context:[],noBreak:false,lastKind:''};sec.hunks.push(h);continue;
  }
  if(sec&&!sec.hunks.length){
   if(l.startsWith('rename from '))sec.oldPath=l.slice(12);else if(l.startsWith('rename to '))sec.newPath=l.slice(10);
   else if(l.startsWith('new file mode'))sec.create=true;else if(l.startsWith('deleted file mode'))sec.del=true;
  }
 }
 return sections.map(s=>{
  const edit:Edit=(tree:Tree)=>{
  const create=s.create||s.oldPath===null,del=s.del||s.newPath===null;
  const old=s.oldPath??'',neu=s.newPath??old;
  if(!create&&!safe(old))throw new Fail('unsafe',old);if(!del&&!safe(neu))throw new Fail('unsafe',neu);
  if(create){if(tree.get(neu)!==null)throw new Fail('exists',neu);const f:FileText={lines:s.hunks.flatMap(x=>x.neu),br:'\n',final:true};if(s.hunks.at(-1)?.noBreak)f.final=false;tree.now.set(neu,render(f));return;}
  const before=tree.get(old);if(before===null)throw new Fail('missing',old);if(del){tree.now.set(old,null);return;}
  if(neu!==old&&tree.get(neu)!==null)throw new Fail('exists',neu);
  const f=fileText(before);let d=0;
  for(const x of s.hunks){
   if(!x.old.length){const at=Math.max(0,Math.min(x.a+d,f.lines.length));f.lines.splice(at,0,...x.neu);if(at+x.neu.length===f.lines.length)f.final=!x.noBreak;}
   else{const found=occurrences(f.lines,x.old,strict);if(!found)throw new Fail('no-match',old);const target=x.a-1+d;const at=found.at.reduce((b,v)=>Math.abs(v-target)<Math.abs(b-target)?v:b,found.at[0]!);const end=at+x.old.length===f.lines.length;replaceLines(f,at,x.old,x.neu,found.tier,x.context);if(end)f.final=!x.noBreak;}
   d+=x.neu.length-x.old.length;
  }
  if(old!==neu){tree.now.set(old,null);tree.now.set(neu,render(f));}else tree.now.set(old,render(f));
  };
  if(s.oldPath!==null&&s.newPath!==null&&s.oldPath!==s.newPath)edit.move=[s.oldPath,s.newPath];
  return edit;
 });
}
function searchEdits(lines:string[],strict:boolean):Edit[]{
 const edits:Edit[]=[];let previous='',last=-1;
 for(let i=0;i<lines.length;i++){
  if(lines[i]!.trimEnd()!=='<<<<<<< SEARCH')continue;let path='';
  for(let j=i-1;j>last;j--)if(!blank(lines[j]!)&&!lines[j]!.trim().startsWith('```')){path=lines[j]!.trim();break;}
  if(!path)path=previous;if(!path)throw new Exit2(`error: parse ${i+1}`);
  let mid=-1,end=-1;for(let j=i+1;j<lines.length;j++){if(mid<0&&lines[j]!.trimEnd()==='=======')mid=j;if(mid>=0&&lines[j]!.trimEnd()==='>>>>>>> REPLACE'){end=j;break;}}
  if(mid<0||end<0)throw new Exit2(`error: parse ${i+1}`);const old=lines.slice(i+1,mid),neu=lines.slice(mid+1,end);
  edits.push(tree=>{if(!safe(path))throw new Fail('unsafe',path);if(!old.length){if(tree.get(path)!==null)throw new Fail('exists',path);tree.now.set(path,neu.length?neu.join('\n')+'\n':'');return;}const before=tree.get(path);if(before===null)throw new Fail('missing',path);const found=occurrences(fileText(before).lines,old,strict);if(!found)throw new Fail('no-match',path);if(found.at.length!==1)throw new Fail('ambiguous',path);const f=fileText(before);replaceLines(f,found.at[0]!,old,neu,found.tier);tree.now.set(path,render(f));});
  previous=path;last=end;i=end;
 }return edits;
}
interface Chunk{anchor:string|null;eof:boolean;old:string[];neu:string[];context:number[]}
function v4aEdits(lines:string[],strict:boolean):Edit[]{
 const first=lines.findIndex(l=>!blank(l));if(first<0||lines[first]!.trim()!=='*** Begin Patch')throw new Exit2(`error: parse ${first<0?1:first+1}`);
 let last=-1;for(let i=lines.length-1;i>=0;i--)if(!blank(lines[i]!)){last=i;break;}if(last<0||lines[last]!.trim()!=='*** End Patch')throw new Exit2(`error: parse ${lines.length+1}`);
 const edits:Edit[]=[];let i=first+1;
 while(i<last){
  if(blank(lines[i]!)){i++;continue;}const l=lines[i]!,add=l.startsWith('*** Add File: '),del=l.startsWith('*** Delete File: '),update=l.startsWith('*** Update File: ');
  if(!add&&!del&&!update)throw new Exit2(`error: parse ${i+1}`);const start=i,path=l.slice(l.indexOf(': ')+2).trim();i++;
  let end=i;while(end<last&&!lines[end]!.startsWith('*** Add File: ')&&!lines[end]!.startsWith('*** Delete File: ')&&!lines[end]!.startsWith('*** Update File: '))end++;
  let body=lines.slice(i,end);while(body.length&&blank(body[body.length-1]!))body.pop();
  if(add){const bad=body.findIndex(x=>x!==''&&!x.startsWith('+'));if(bad>=0)throw new Exit2(`error: parse ${i+1+bad}`);const added=body.map(x=>x===''?'':x.slice(1));const text=added.length?added.join('\n')+'\n':'';edits.push(tree=>{if(!safe(path))throw new Fail('unsafe',path);if(tree.get(path)!==null)throw new Fail('exists',path);tree.now.set(path,text);});}
  else if(del){if(body.length)throw new Exit2(`error: parse ${i+1}`);edits.push(tree=>{if(!safe(path))throw new Fail('unsafe',path);if(tree.get(path)===null)throw new Fail('missing',path);tree.now.set(path,null);});}
  else{
   let move:string|null=null;if(body[0]?.startsWith('*** Move to: ')){move=body[0].slice(13).trim();body=body.slice(1);}const chunks:Chunk[]=[];let c:Chunk|null=null;
   for(let j=0;j<body.length;j++){const x=body[j]!;if(x.startsWith('@@')){c={anchor:x.slice(2).trim()||null,eof:false,old:[],neu:[],context:[]};chunks.push(c);continue;}if(x==='*** End of File'){if(!c)throw new Exit2(`error: parse ${i+1+j+(move?1:0)}`);c.eof=true;c=null;continue;}if(x!==''&&![' ','-','+'].includes(x[0]!))throw new Exit2(`error: parse ${i+1+j+(move?1:0)}`);if(!c){c={anchor:null,eof:false,old:[],neu:[],context:[]};chunks.push(c);}const text=x===''?'':x.slice(1);if(x.startsWith('-'))c.old.push(text);else if(x.startsWith('+'))c.neu.push(text);else{c.context[c.neu.length]=c.old.length;c.old.push(text);c.neu.push(text);}}
   if(!chunks.length&&!move)throw new Exit2(`error: parse ${start+1}`);
   edits.push(Object.assign(tree=>{if(!safe(path))throw new Fail('unsafe',path);if(move!==null&&!safe(move))throw new Fail('unsafe',move);const before=tree.get(path);if(before===null)throw new Fail('missing',path);if(move!==null&&tree.get(move)!==null)throw new Fail('exists',move);const f=fileText(before);let cursor=0;
    for(const x of chunks){if(x.anchor!==null){const found=occurrences(f.lines,[x.anchor],strict,cursor);if(!found)throw new Fail('no-match',path);cursor=found.at[0]!+1;}let at=cursor,tier=0;if(x.old.length){const found=occurrences(f.lines,x.old,strict,cursor,x.eof);if(!found)throw new Fail('no-match',path);at=found.at[0]!;tier=found.tier;}else if(x.eof)at=f.lines.length;replaceLines(f,at,x.old,x.neu,tier,x.context);cursor=at+x.neu.length;}
    if(move!==null){tree.now.set(path,null);tree.now.set(move,render(f));}else tree.now.set(path,render(f));},move?{move:[path,move]}:{}));
  }i=end;
 }return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : searchEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string,string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
      if (edit.move) moves.push(edit.move);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { sort: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const [oldPath, newPath] of moves) {
    if (oldPath === newPath || moved.has(oldPath) || moved.has(newPath)) continue;
    if (tree.original(oldPath) !== null && tree.get(oldPath) === null && tree.original(newPath) === null && tree.get(newPath) !== null) {
      moved.add(oldPath); moved.add(newPath); rows.push({ sort: newPath, line: `R ${oldPath} -> ${newPath}` });
    }
  }
  for (const p of tree.now.keys()) {
    if (moved.has(p)) continue;
    const was = tree.original(p), now = tree.now.get(p)!;
    if (was !== now) rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  if (!check) for (const [p, now] of tree.now) {
    if (tree.original(p) === now) continue;
    if (now === null) rmSync(p, { force: true });
    else atomicWrite(p, now);
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
