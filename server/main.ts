import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupNow } from './backup';
import { createApp, VERSION } from './app';
import { Devices } from './devices';
import { startHost } from './host';
import { Sharing } from './share';
import { Team } from './team';
import { openStore } from './store';

/**
 * efeu Cloud: der Server für die eigene Cloud.
 *
 *   node efeu-server.mjs                       Server starten
 *   node efeu-server.mjs add-device "MacBook"  Gerät anlegen, gibt dessen Schlüssel als JSON aus
 *   node efeu-server.mjs pairing-code          Einmaligen Kopplungscode für ein weiteres Gerät ausgeben
 *   node efeu-server.mjs invite                Einladung ins Team (Link: <adresse>/team/<code>)
 *
 * Einstellungen über Umgebungsvariablen: EFEU_DATA (Datenordner), EFEU_WEB (Web-Oberfläche), EFEU_HOST, EFEU_PORT.
 */
const dir = process.env.EFEU_DATA || './efeu-daten';
const host = process.env.EFEU_HOST || '127.0.0.1';
const port = Number(process.env.EFEU_PORT || 8080);
/** Web-Oberfläche für Browser und Handy (liegt neben der Server-Datei im Ordner web). */
const web = process.env.EFEU_WEB || join(dirname(fileURLToPath(import.meta.url)), 'web');

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const store = openStore(dir);
  const devices = new Devices(store);

  if (command === 'add-device') {
    const { device, token } = devices.add(args[0] ?? 'Gerät');
    process.stdout.write(`${JSON.stringify({ id: device.id, token })}\n`);
    return;
  }
  if (command === 'pairing-code') {
    process.stdout.write(`${JSON.stringify(devices.pairingCode())}\n`);
    return;
  }
  if (command === 'invite') {
    // Einladung ins Team ohne App (z. B. für Docker); gibt den Code aus, der Link ist <adresse>/team/<code>.
    process.stdout.write(`${JSON.stringify(new Team(store).createInvite())}\n`);
    return;
  }
  if (command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command && command !== 'serve') {
    process.stderr.write(`Unbekannter Befehl: ${command}\n`);
    process.exitCode = 2;
    return;
  }

  const sharing = new Sharing(store, web, devices);
  const team = new Team(store);
  const { cloud, teamChanged } = await startHost(store, sharing, team);
  const server = createApp({ store, cloud, devices, sharing, team, teamChanged });
  server.listen(port, host, () => console.log(`efeu Cloud ${VERSION} läuft auf http://${host}:${port} (Daten: ${dir})`));

  const daily = () => {
    try {
      const name = backupNow(store);
      if (name) console.log(`Sicherung angelegt: ${name}`);
    } catch (err) {
      console.error('Sicherung fehlgeschlagen', err);
    }
    void cloud.compactIfLarge().catch((err) => console.error('Aufräumen fehlgeschlagen', err));
  };
  daily();
  setInterval(daily, 60 * 60 * 1000).unref();

  const stop = () => {
    server.close();
    store.raw.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
