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