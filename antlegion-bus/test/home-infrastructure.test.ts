import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusV2 } from '../src/bus.js';
import { createServerV2 } from '../src/server.js';
const dir = () => mkdtempSync(join(tmpdir(), 'ant-home-'));
const fact = (n: number) => ({ type: 'home.test', author: 'agent', ts: n, payload: { text: '客厅', n } });
describe('home infrastructure', () => {
  it('repairs a torn UTF-8 tail before new writes and survives another restart', () => {
    const dataDir=dir(), path=join(dataDir, 'facts-v2.jsonl');
    let bus=new BusV2({ dataDir, secret: 'stable' }); bus.append(fact(1)); bus.close();
    appendFileSync(path, Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xe5,0xae])]));
    bus=new BusV2({ dataDir, secret: 'stable' }); expect(bus.info().recovered_tail_bytes).toBeGreaterThan(0); bus.append(fact(2)); bus.close();
    bus=new BusV2({ dataDir, secret: 'stable' }); expect(bus.all().map(f=>f.ts)).toEqual([1,2]); expect(bus.info().sig_failures).toBe(0); bus.close();
  });
  it('preserves a complete unterminated record and rejects corrupt complete records', () => {
    const dataDir=dir(), path=join(dataDir, 'facts-v2.jsonl');
    let bus=new BusV2({ dataDir, secret: 'stable' }); bus.append(fact(1)); bus.close();
    writeFileSync(path, readFileSync(path, 'utf8').trimEnd());
    bus=new BusV2({ dataDir, secret: 'stable' }); bus.append(fact(2)); bus.close();
    bus=new BusV2({ dataDir, secret: 'stable' }); expect(bus.all()).toHaveLength(2); bus.close();
    appendFileSync(path, 'bad record\n'); const before=readFileSync(path, 'utf8');
    expect(()=>new BusV2({ dataDir, secret: 'stable' })).toThrow(/corrupt journal/); expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('protects APIs and folds the complete stream after restart', async () => {
    const dataDir=dir(), opts={ dataDir, secret:'stable', apiToken:'access', fsync:'no' as const };
    let { app,bus }=createServerV2(opts);
    expect((await app.request('/facts')).status).toBe(401);
    expect((await app.request('/ops/overview',{headers:{authorization:'Bearer wrong'}})).status).toBe(401);
    expect((await app.request('/health')).status).toBe(200);
    bus.append({ type:'sys.registry',author:'old-agent',ts:1,payload:{interests:['home.*'],publishes:['home.test']} });
    for(let n=0;n<2100;n++) bus.append(fact(n));
    const first=bus.append({type:'home.state',author:'agent',ts:3000,payload:{temperature:29},refs:{subject:'room'}});
    bus.append({type:'home.state',author:'agent',ts:3001,payload:{temperature:26},refs:{subject:'room',parent:first.id}});
    bus.close(); ({app,bus}=createServerV2(opts)); const headers={authorization:'Bearer access'};
    const overview=await (await app.request('/ops/overview',{headers})).json();
    expect(overview.agents.find((a:{author:string})=>a.author==='old-agent').interests).toEqual(['home.*']); expect(overview.latest_facts).toHaveLength(100);
    const subject=await (await app.request('/ops/subject?name=room',{headers})).json(); expect(subject.current.payload.temperature).toBe(26); expect(subject.history).toHaveLength(2);
    const detail=await (await app.request('/ops/fact/'+first.id,{headers})).json(); expect(detail.descendants).toHaveLength(1); expect(detail.head_seq).toBe(bus.headSeq()); bus.close();
  });
});
