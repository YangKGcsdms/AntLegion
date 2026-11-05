import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClientV2, httpTransport } from '../dist/client.js';
const role = process.env.ANTLEGION_DEMO_ROLE;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!role) {
  const run = randomUUID();
  console.log('启动四个独立演示进程，演示数据写入独立总线。');
  const workers = ['environment', 'comfort', 'actuator-a', 'actuator-b'].map(name => spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit', env: { ...process.env, ANTLEGION_DEMO_ROLE: name, ANTLEGION_DEMO_RUN: run },
  }));
  const stop = () => workers.forEach(w => w.kill('SIGTERM'));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const statuses = await Promise.all(workers.map(w => new Promise((resolve, reject) => {
    w.on('error', reject); w.on('exit', (code, signal) => resolve({ code, signal }));
  })));
  if (statuses.some(s => s.code !== 0)) { console.error('演示进程失败', statuses); process.exitCode = 1; }
  else console.log('演示完成，可在控制台查看事实流与回放。');
} else {
  const base = process.env.ANTLEGION_BUS_URL || 'http://localhost:28090';
  const transport = httpTransport(base, { token: process.env.ANTLEGION_API_TOKEN });
  const client = new ClientV2(transport, 'demo.' + role);
  const run = process.env.ANTLEGION_DEMO_RUN;
  const settings = {
    environment: { interests: [], publishes: ['home.environment.observed'] },
    comfort: { interests: ['home.environment.observed'], publishes: ['home.comfort.needed'] },
    'actuator-a': { interests: ['home.comfort.needed'], publishes: ['home.aircon.observed'] },
    'actuator-b': { interests: ['home.comfort.needed'], publishes: ['home.aircon.observed'] },
  };
  if (!settings[role]) throw new Error('unknown demo role');
  await client.publish('sys.registry', settings[role]);
  async function waitFor(type) {
    let cursor = 0;
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const facts = await transport.read({ since: cursor, limit: 500, type });
      for (const fact of facts) { cursor = Math.max(cursor, fact.seq); if (fact.payload.run === run) return fact; }
      await pause(300);
    }
    throw new Error(role + ' timed out waiting for ' + type);
  }
  if (role === 'environment') {
    await pause(2000);
    const observation = await client.publish('home.environment.observed', { run, temperature_c: 29, humidity_percent: 78 }, { refs: { subject: 'home:living-room:environment' } });
    console.log(role, '发布环境观察', observation.id);
  } else if (role === 'comfort') {
    const observation = await waitFor('home.environment.observed');
    await pause(700);
    const need = await client.publish('home.comfort.needed', { run, reason: '客厅温度偏高' }, { refs: { parent: observation.id } });
    console.log(role, '发布调节需求', need.id);
  } else {
    const need = await waitFor('home.comfort.needed');
    const claim = await client.claim(need.id);
    console.log(role, '认领结果', claim);
    if (claim.won) {
      await pause(1000);
      const result = await client.publish('home.aircon.observed', { run, power: 'on', target_c: 26, simulated: true }, { refs: { parent: need.id, subject: 'home:living-room:aircon' } });
      await client.resolve(need.id);
      console.log(role, '发布模拟设备状态', result.id);
    }
  }
}
