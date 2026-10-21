import { setDriver, type Driver } from '../db/driver';
import { flush } from '../db/saveQueue';
import { useDatabases } from '../store/databases';
import { usePages } from '../store/pages';
import { createTestDriver } from './sqliteDriver';

/** Frische In-Memory-Datenbank und leere Stores für jeden Test. */
export async function freshDatabase(): Promise<Driver & ReturnType<typeof createTestDriver>> {
  await flush();
  const driver = createTestDriver();
  setDriver(driver);
  usePages.setState({ pages: {}, children: new Map(), categories: {}, defaultSpace: 'private' });
  useDatabases.setState({ data: {} });
  return driver;
}
