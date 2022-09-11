import type { Message } from 'discord.js'
import { promises as fsp } from 'fs'

export function stringifyError(e: unknown): string {
	return e instanceof Error ? e.stack ?? e.message : String(e)
}

export function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
	return (
		e instanceof Error && typeof (e as NodeJS.ErrnoException).code === 'string'
	)
}

export async function loadJsonFile<T>(
	path: string,
	assertor: (this: void, v: unknown) => asserts v is T,
): Promise<T> {
	const url = new URL(path, import.meta.url)
	console.info(`[loadJsonFile] loading '${url}' (path = '${path}')`)
	const content = await fsp.readFile(url, 'utf8')
	const data = JSON.parse(content)
	assertor(data)
	return data
}

export async function saveJsonFile(path: string, data: unknown): Promise<void> {
	const url = new URL(path, import.meta.url)
	console.info(`[saveJsonFile] saving '${url}' (path = '${path}')`)
	return fsp.writeFile(url, JSON.stringify(data), 'utf8')
}

export function stringifyNumber(value: number, radix: number): string {
	const GroupSize = 4

	const rawRepresentation = value.toString(radix)

	return rawRepresentation
		.split('')
		.map((c, i) =>
			// insert a space every 4 digits, excluding the first one.
			i !== 0 &&
			(rawRepresentation.length - 1 - i) % GroupSize === GroupSize - 1
				? ` ${c}`
				: c,
		)
		.join('')
}

export async function deleteMessageWithDelay(
	messagePromise: Promise<Message>,
	delayMs: number,
): Promise<void> {
	try {
		const message = await messagePromise
		return new Promise((resolve) => {
			setTimeout(async () => {
				try {
					await message.delete()
				} catch (e) {
					console.error('[deleteMessageWithDelay] delete', e)
				}
				resolve()
			}, delayMs)
		})
	} catch (e) {
		console.error('[deleteMessageWithDelay] send', e)
	}
}
