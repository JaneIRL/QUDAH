import type { Snowflake } from 'discord.js'
import { loadJsonFile } from './util.js'

const Path = process.env['CONFIG_PATH'] ?? './config.json'

export interface QudahConfig {
	token: string
	radix: Radix
	channel: Snowflake
	guild: Snowflake
}
function assertQudahConfig(
	this: void,
	obj: unknown,
): asserts obj is QudahConfig {
	const { token, radix, channel, guild } = obj as Record<string, unknown>
	if (typeof token !== 'string') {
		throw new Error('invalid token; string expected')
	} else if (!isRadix(radix)) {
		throw new Error('invalid radix; 2, 10, or 16 expected')
	} else if (typeof channel !== 'string') {
		throw new Error('invalid channel; Snowflake ID in string form expected')
	} else if (typeof guild !== 'string') {
		throw new Error('invalid guild; Snowflake ID in string form expected')
	}
}

const Radixes = Object.freeze([2, 10, 16] as const)
export type Radix = typeof Radixes[number]
function isRadix(n: unknown): n is Radix {
	return Radixes.includes(n as Radix)
}

export async function loadConfig(): Promise<Readonly<QudahConfig>> {
	return Object.freeze(await loadJsonFile(Path, assertQudahConfig))
}
