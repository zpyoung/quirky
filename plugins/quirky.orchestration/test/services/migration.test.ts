import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPluginStore } from '../../../../packages/daemon/src/plugins/stores'
import { migrations } from '../../src/store'
import { serviceMigrations } from '../../src/services/migrations'

const homes: string[] = []
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close()
  for (const home of homes.splice(0)) rmSync(home, { recursive:true,force:true })
})

test('service provenance migration preserves old work and the mailbox sequence high-water mark', () => {
  const home = mkdtempSync(join(tmpdir(), 'orchestration-service-migrate-'))
  homes.push(home)
  const old = openPluginStore({ home,pluginId:'quirky.orchestration',migrations,isActive:() => true })
  closers.push(old.close)
  const at = '2026-10-27T00:00:00.000Z'
  old.store.run('INSERT INTO runs(id,objective,created_at,updated_at) VALUES(?,?,?,?)','run_preserved','Preserve existing work',at,at)
  old.store.run(`INSERT INTO tasks(id,run_id,created_by_session_id,task_title,display_name,spec,status,created_at)
    VALUES(?,?,?,?,?,?,?,?)`,'task_preserved','run_preserved','session_existing','Existing task','Existing task','spec.md','ready',at)
  const insertMessage = `INSERT INTO messages(sequence,id,run_id,from_session_id,sender_kind,sender_id,mailbox_kind,mailbox_id,subject,body,type,priority,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
  old.store.run(insertMessage,1,'msg_preserved','run_preserved','session_existing','session','session_existing','run','run_preserved','Preserved','Existing message','status','normal',at)
  old.store.run(insertMessage,100,'msg_pruned','run_preserved','session_existing','session','session_existing','run','run_preserved','Pruned','Old message','status','normal',at)
  old.store.run('DELETE FROM messages WHERE id=?','msg_pruned')
  old.close()

  const upgraded = openPluginStore({ home,pluginId:'quirky.orchestration',migrations:[...migrations,...serviceMigrations],isActive:() => true })
  closers.push(upgraded.close)
  expect(upgraded.store.get('SELECT created_by_session_id,created_by_plugin_id,created_by_kind FROM tasks WHERE id=?','task_preserved'))
    .toEqual({ created_by_session_id:'session_existing',created_by_plugin_id:null,created_by_kind:'session' })
  expect(upgraded.store.get('SELECT body,read FROM messages WHERE id=?','msg_preserved')).toEqual({ body:'Existing message',read:0 })
  upgraded.store.run(`INSERT INTO messages(id,run_id,from_session_id,sender_kind,sender_id,mailbox_kind,mailbox_id,subject,body,type,priority,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,'msg_after','run_preserved','session_existing','session','session_existing','run','run_preserved','After','New message','status','normal',at)
  expect(upgraded.store.get<{ sequence:number }>('SELECT sequence FROM messages WHERE id=?','msg_after')?.sequence).toBe(101)
})
