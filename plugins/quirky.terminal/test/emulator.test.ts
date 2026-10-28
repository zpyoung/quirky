import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanupAll, E2eHarness } from './e2e-support'

afterEach(cleanupAll)

const device = '11111111-2222-3333-4444-555555555555'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='

test('simulator CLI lists real provider-format devices and the API returns only the exact selected device frame', async () => {
  const harness = await E2eHarness.start({ builtinPluginsDir(home) {
    mkdirSync(join(home, 'bin'), { recursive: true })
    const command = join(home, 'bin', 'xcrun')
    writeFileSync(command, `#!${process.execPath}\nconst a=process.argv.slice(2); if(a.join(' ')==='simctl list devices available --json') console.log(JSON.stringify({devices:{runtime:[{udid:'${device}',name:'Owned simulator',state:'Booted',isAvailable:true}]}})); else if(a[0]==='simctl'&&a[1]==='io'&&a[2]==='${device}'&&a[3]==='screenshot'&&a[4]==='--type=png') await Bun.write(a[5],Buffer.from('${png}','base64')); else {console.error('Unknown exact simulator');process.exit(1)}\n`)
    chmodSync(command, 0o755)
    return resolve(import.meta.dir, '../../..', 'plugins')
  } })
  expect(await harness.json(['terminal', 'emulators'])).toEqual({ available: true, devices: [{ id: device, name: 'Owned simulator', state: 'Booted', runtime: 'runtime' }] })
  expect(await harness.call('quirky.terminal/emulatorFrame', { device })).toMatchObject({ device, mime: 'image/png', data: png })
  await expect(harness.call('quirky.terminal/emulatorFrame', { device: 'booted' })).rejects.toThrow('exact simulator')
  await expect(harness.call('quirky.terminal/emulatorFrame', { device: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).rejects.toThrow('Unknown exact simulator')
})
