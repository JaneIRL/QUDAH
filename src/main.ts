import {
	Awaitable,
	Client,
	ClientEvents,
	EmbedBuilder,
	Guild,
	TextChannel,
	Webhook,
} from 'discord.js'
import { loadConfig, QudahConfig, Radix } from './config.js'
import { loadStore, Store, updateStore } from './store.js'
import { deleteMessageWithDelay, stringifyNumber } from './util.js'

const client = new Client({
	intents: ['Guilds', 'GuildMessages', 'GuildWebhooks', 'MessageContent'],
})

try {
	const config = await loadConfig()
	/** a single-element tuple of an immutable object */
	const storePtr: [Readonly<Store>] = [await loadStore()]
	await client.login(config.token)

	const channel = await client.channels.fetch(config.channel)
	if (!channel || !(channel instanceof TextChannel)) {
		throw new Error(`text channel '${config.channel}' not found`)
	}

	const guild = await client.guilds.fetch(config.guild)
	if (!guild) {
		throw new Error(`guild '${config.guild}' not found`)
	}

	let webhook: Webhook | undefined
	if (!storePtr[0].webhook) {
		webhook = await channel.createWebhook({
			name: 'QUDAH',
		})
		await updateStore(storePtr, { webhook: webhook.id })
	} else {
		webhook = await client.fetchWebhook(storePtr[0].webhook)
	}

	client.on(
		'messageCreate',
		getMessageCreateHandler(config, storePtr, webhook, guild),
	)
} catch (e) {
	console.error('[startup]', e)
	client.destroy()
}

function getMessageCreateHandler(
	config: QudahConfig,
	storePtr: [Readonly<Store>],
	webhook: Webhook,
	guild: Guild,
): (...args: ClientEvents['messageCreate']) => Awaitable<void> {
	const NoticeDurationMs = 5_000

	let layerCounter = 0
	return async (message) => {
		if (
			message.channelId !== config.channel ||
			message.author.bot ||
			message.author.system
		) {
			return
		}

		layerCounter++

		try {
			if (layerCounter > 1) {
				// race condition
				sendNotice('that was took quick, please try again later.')
				return
			}

			if (message.author.id === storePtr[0].previous_user) {
				sendNotice('you can only count once in a row.')
				return
			}

			const previousValue = storePtr[0].previous_value
			const parsedMessage = parseUserMessage(
				message.content,
				config.radix,
				previousValue ? previousValue + 1 : undefined,
			)

			if (parsedMessage.representation === '') {
				sendNotice("i couldn't find any numbers in your previous message.")
				return
			}

			const member = await guild.members.fetch(message.author.id)

			// resend user message as a webhook message for formatting
			await webhook.send({
				content: `\`${stringifyNumber(parsedMessage.value, config.radix)}\`${
					parsedMessage.note
						? // pipes in the note are removed by parseUserMessage so it is safe to pass it here directly.
						  ` ||${parsedMessage.note}||`
						: ''
				}`,
				username: member.displayName,
				avatarURL: member.displayAvatarURL(),
			})

			// check if the user submitted value is correct
			if (
				previousValue === undefined ||
				parsedMessage.value === previousValue + 1
			) {
				await updateStore(storePtr, {
					previous_user: message.author.id,
					previous_value: parsedMessage.value,
				})
			} else {
				if (config.resume_on_error) {
					sendNotice(`no, \`${stringifyNumber(parsedMessage.value, config.radix)}\` is not it.`)
				} else {
					await webhook.send({
						embeds: [
							new EmbedBuilder()
								.setTitle('defective unit detected')
								.setDescription(
									`<@${message.author.id}> just malfunctioned!
							\`\`\`diff
							+ ${stringifyNumber(previousValue + 1, config.radix)}
							- ${stringifyNumber(parsedMessage.value, config.radix)}
							\`\`\`
							we successfully counted to \`${stringifyNumber(
								previousValue,
								config.radix,
							)}\` (decimal \`${previousValue}\`). let's try again starting from \`0\`.
							`.replace(/^\s+/gm, ''),
								),
						],
					})
				}
				await updateStore(storePtr, {
					previous_user: message.author.id,
					...(config.resume_on_error ? {} : { previous_value: -1 }),
				})
			}
		} catch (e) {
			console.error('[messageCreateHandler]', e)
		} finally {
			try {
				await message.delete()
			} catch (e) {
				console.error('[messageCreateHandler] message.delete', e)
			}
			layerCounter--
		}

		function sendNotice(content: string) {
			void deleteMessageWithDelay(
				message.channel.send({
					content: `<@${message.author.id}> ${content}`,
					allowedMentions: { parse: ['users'] },
				}),
				NoticeDurationMs,
			)
		}
	}
}

interface UserMessage {
	representation: string
	note: string
	value: number
}

function parseUserMessage(
	message: string,
	radix: Radix,
	expectedValue: number | undefined,
): UserMessage {
	type State = 'prefix' | 'representation' | 'note'
	const DigitSet = new Set(
		[
			// '0' to '9'
			...new Array(10).fill(42).map((_, i) => `${i}`),
			// 'a' to 'f'
			...new Array(6)
				.fill(42)
				.map((_, i) => String.fromCharCode('a'.charCodeAt(0) + i)),
		].slice(0, radix),
	)
	if (radix > 10) {
		DigitSet.add('x')
	}
	const DeniedPattern = /^[|\u200f]$/iu
	const WhitespacePattern = /^[ \t\n\r]$/iu

	const ans: UserMessage = {
		representation: '',
		note: '',
		value: 0,
	}
	const prefix: string[] = []
	let state: State = 'prefix'

	// ┌────────┐  (digit)   ┌──────────────────┐   (else)    ┌────────────────┐
	// │ prefix ├───────────►│  representation  ├────────────►│      note      │
	// └────┬───┘            └────┬──────────┬──┘             └──┬────────────┬┘
	//    △ │ (else)            △ │ (digit)  │ (whitespace)    △ │ (else)     │ (prefix / denied)
	//    └─┘                   └─┘          ▽                 └─┘            ▽
	//                                 ┌───────────┐                    ┌───────────┐
	//                                 │ /dev/null │                    │ /dev/null │
	//                                 └───────────┘                    └───────────┘
	//
	// legend:
	// * ────► transition state to. no character is consumed.
	// * ────▷ append character to. character is consumed.
	//
	// early termination condition:
	// if the current value is the expected value,
	// the state will be changed to "note" immediately.

	for (const char of message) {
		if (state === 'prefix') {
			if (DigitSet.has(char.toLowerCase())) {
				state = 'representation'
			} else {
				prefix.push(char)
			}
		}
		if (state === 'representation') {
			if (DigitSet.has(char.toLowerCase())) {
				ans.representation += char
				if (parseInt(ans.representation, radix) === expectedValue) {
					// Early termination.
					state = 'note'
					continue
				}
			} else if (!WhitespacePattern.test(char)) {
				state = 'note'
			}
		}
		if (state === 'note') {
			const indexInPrefix = prefix.indexOf(char)
			if (indexInPrefix > -1) {
				prefix.splice(indexInPrefix, 1)
				continue
			}

			if (!DeniedPattern.test(char)) {
				ans.note += char
			}
		}
	}

	ans.value = parseInt(ans.representation, radix)

	if (isNaN(ans.value)) {
		ans.value = 0
	}

	return ans
}
