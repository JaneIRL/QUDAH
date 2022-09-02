import type { Snowflake } from 'discord.js'
import { isErrnoException, loadJsonFile, saveJsonFile } from './util.js'

const Path = process.env['STORE_PATH'] ?? './store.json'

export interface Store {
	previous_value?: number
	webhook?: Snowflake
}
function assertStore(_v: unknown): asserts _v is Store {
	// TODO
}

const FallbackStore = Object.freeze({})

export async function loadStore(): Promise<Readonly<Store>> {
	try {
		return await loadJsonFile(Path, assertStore)
	} catch (e) {
		if (isErrnoException(e) && e.code === 'ENOENT') {
			// store file doesn't exist yet, we will return the fallback value.
			return FallbackStore
		} else {
			// rethrow other errors.
			throw e
		}
	}
}

export async function updateStore(
	storePtr: [Readonly<Store>],
	delta: Partial<Store>,
): Promise<void> {
	const newStore = Object.freeze({ ...storePtr[0], ...delta })
	await saveJsonFile(Path, newStore)
	storePtr[0] = newStore
}
