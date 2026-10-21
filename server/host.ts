import { setDriver } from '../src/db/driver';
import { flush, onWrite } from '../src/db/saveQueue';
import { loadGrants, loadMembers } from '../src/db/share';
import { useHosting } from '../src/features/collab/host/hosting';
import { hubBoards, hubDocs, startHub, syncAccess } from '../src/features/collab/host/hub';
import type { Applied, ReplicaHooks } from '../src/sync/replica';
import { useDatabases } from '../src/store/databases';
import { usePages } from '../src/store/pages';
import { Cloud } from './cloud';
import type { Sharing } from './share';
import type { Team } from './team';
import type { Store } from './store';

/**
 * Der Server als Gastgeber: dieselben Stores und derselbe Hub wie in der App, nur ohne Fenster.
 * Was Gäste ändern, landet über die Schreib-Warteschlange in der Datenbank und von dort im Protokoll
 * für die eigenen Geräte; was die Geräte hochladen, wird in die Stores und offenen Dokumente übernommen.
 */
export async function startHost(store: Store, sharing: Sharing, team: Team): Promise<{ cloud: Cloud; teamChanged: () => void }> {
  setDriver(store);
  const hooks: ReplicaHooks = {
    openDoc: (page) => hubDocs()?.peek(page),
    boardMerged: (page, elements, files) => hubBoards()?.external(page, elements, files),
  };
  let cloud: Cloud | null = null;
  const refresh = async (applied: Applied) => {
    if (!applied.rows) return;
    // Erst Ausstehendes schreiben, sonst überschriebe der neu geladene Stand eine laufende Änderung.
    await flush();
    await usePages.getState().load();
    const loaded = Object.keys(useDatabases.getState().data);
    await Promise.all(loaded.map((id) => useDatabases.getState().load(id).catch(() => undefined)));
    team.cleanup();
    useHosting.setState({ members: await loadMembers(), grants: await loadGrants() });
    syncAccess();
    sharing.dropRemoved();
  };
  cloud = new Cloud(store, hooks, (applied) => void refresh(applied).catch((err) => console.error('Ansichten nachführen', err)));
  await cloud.start();

  await usePages.getState().load();
  useHosting.setState({ members: await loadMembers(), grants: await loadGrants(), hostName: 'efeu' });
  if (sharing.hasWebApp) {
    const replica = cloud.replica;
    await startHub({ ...sharing.transport(), loadDoc: (page) => replica.loadDoc(page) });
  }

  // Änderungen aus dem Browser kurz sammeln und dann für die Geräte bereitstellen.
  let timer: ReturnType<typeof setTimeout> | null = null;
  onWrite(() => {
    timer ??= setTimeout(() => {
      timer = null;
      void cloud!.drainLocal().catch((err) => console.error('Änderungen aus dem Browser', err));
    }, 300);
  });
  const teamChanged = () => {
    team.cleanup();
    void (async () => {
      useHosting.setState({ members: await loadMembers(), grants: await loadGrants() });
      syncAccess();
      sharing.dropRemoved();
      await cloud!.drainLocal();
    })().catch((err) => console.error('Team nachführen', err));
  };
  return { cloud, teamChanged };
}
