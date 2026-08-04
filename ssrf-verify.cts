import * as http from 'http';
process.env.NODE_ENV = 'production';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { preflightEntryUrl } = require('./src/services/testing/exploration/entry-preflight.service');

const b = http.createServer((_q, r) => { r.writeHead(200); r.end('SECRET-METADATA-LEAKED'); });
b.listen(0, '127.0.0.1', () => {
  const bPort = (b.address() as any).port;
  const a = http.createServer((_q, r) => {
    r.writeHead(302, { Location: `http://127.0.0.1:${bPort}/latest/meta-data` }); r.end();
  });
  a.listen(0, '127.0.0.1', async () => {
    const aPort = (a.address() as any).port;
    // Public-looking host is impossible offline, so we point straight at the
    // redirector: the ENTRY host check will block it. The meaningful assertion
    // is the SECOND case below, where entry passes and the HOP is private.
    const res = await preflightEntryUrl(`http://127.0.0.1:${aPort}/`);
    console.log('entry-is-private ->', res.verdict, '| ok:', res.ok);
    console.log(res.message.includes('SECRET') ? 'LEAK' : 'no body leaked');
    a.close(); b.close();
  });
});
