import type { Snowflake } from 'discord.js'
import { isErrnoException, loadJsonFile, saveJsonFile } from './util.js'

const Path = process.env['STORE_PATH'] ?? './store.json'

export interface Store {
	previous_timestamp?: number
	previous_user?: Snowflake
	previous_value?: number
	roles: Record<string, Snowflake[]>
	webhook?: Snowflake
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assertStore(v: any): asserts v is Store {
	if (!(v.roles && typeof v.roles === 'object')) {
		throw new Error('Not a valid store object.')
	}
}

const FallbackStore = Object.freeze({
	roles: { pronouns: [] },
})

export async function loadStore(): Promise<Store> {
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

export async function saveStore(store: Store): Promise<void> {
	return saveJsonFile(Path, store)
}
