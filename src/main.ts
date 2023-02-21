import {
	ActionRowBuilder,
	Awaitable,
	ButtonBuilder,
	ButtonInteraction,
	ButtonStyle,
	ChatInputCommandInteraction,
	Client,
	ClientEvents,
	EmbedBuilder,
	Guild,
	Message,
	PermissionFlagsBits,
	RESTPostAPIApplicationCommandsJSONBody,
	Routes,
	SelectMenuBuilder,
	SelectMenuOptionBuilder,
	SlashCommandBuilder,
	SlashCommandIntegerOption,
	SlashCommandRoleOption,
	SlashCommandStringOption,
	SlashCommandSubcommandBuilder,
	SlashCommandSubcommandGroupBuilder,
	TextChannel,
	Webhook,
} from 'discord.js'
import { loadConfig, QudahConfig, Radix } from './config.js'
import { loadStore, saveStore, Store } from './store.js'
import { deleteMessageWithDelay, stringifyNumber } from './util.js'
import * as readline from 'readline'

const SelectMenuMaxOptions = 25
const MaxCategories = 10
const SaveStoreIntervalMs = 3600_000
const InteractionTimeoutMs = 120_000
const CountItMyselfMinIntervalMs = 1000
// 1 hour
const CountItMyselfBiasMs = 1 * 60 * 60 * 1000

const client = new Client({
	intents: ['Guilds', 'GuildMessages', 'GuildWebhooks', 'MessageContent'],
})

try {
	const config = await loadConfig()
	const store = await loadStore()
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
	if (!store.webhook) {
		webhook = await channel.createWebhook({
			name: 'QUDAH',
		})
		store.webhook = webhook.id
	} else {
		webhook = await client.fetchWebhook(store.webhook)
	}

	client.on(
		'messageCreate',
		getMessageCreateHandler(config, store, webhook, guild),
	)

	await registerCommands(client, config, guild, store)

	setInterval(() => saveStore(store), SaveStoreIntervalMs)

	countItMyself(config, store, webhook)

	readline
		.createInterface({
			input: process.stdin,
		})
		.on('line', (line) => {
			if (line === 'exit') {
				exit(store)
			} else if (line === 'save') {
				saveStore(store)
			}
		})

	process.on('SIGINT', () => {
		exit(store)
	})

	console.info(`[main] Bot is up at ${client.ws.ping} ms ping.`)
} catch (e) {
	console.error('[startup]', e)
	client.destroy()
}

async function exit(store: Store) {
	console.info('[main] Exiting...')
	await saveStore(store)
	client.destroy()
	process.exit()
}

function getMessageCreateHandler(
	config: QudahConfig,
	store: Store,
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

			if (message.author.id === store.previous_user) {
				sendNotice('you can only count once in a row.')
				return
			}

			const previousValue = store.previous_value
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

			const isCorrect =
				previousValue === undefined || parsedMessage.value === previousValue + 1

			// resend user message as a webhook message for formatting
			await sendCountingMessage({
				avatarURL: member.displayAvatarURL(),
				config,
				note: parsedMessage.note,
				strikethrough: !isCorrect,
				username: member.displayName,
				value: parsedMessage.value,
				webhook,
			})

			store.previous_timestamp = new Date().getTime()

			if (isCorrect) {
				store.previous_user = message.author.id
				store.previous_value = parsedMessage.value
			} else {
				if (!config.resume_on_error) {
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
				store.previous_user = message.author.id
				if (!config.resume_on_error) {
					store.previous_value = -1
				}
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

function formatCountingMessage({
	config,
	note,
	strikethrough,
	value,
}: {
	config: QudahConfig
	note?: string | undefined
	strikethrough?: boolean
	value: number
}) {
	return `${strikethrough ? '~~' : ''}\`${stringifyNumber(
		value,
		config.radix,
	)}\`${strikethrough ? '~~' : ''}${note ? ` ${note}` : ''}`
}

async function sendCountingMessage({
	avatarURL,
	config,
	note,
	strikethrough,
	username,
	value,
	webhook,
}: {
	avatarURL?: string | undefined
	config: QudahConfig
	note?: string | undefined
	strikethrough?: boolean
	username?: string | undefined
	value: number
	webhook: Webhook
}) {
	await webhook.send({
		content: formatCountingMessage({ config, note, strikethrough, value }),
		username,
		avatarURL,
	})
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
			...newArray(10, (i) => `${i}`),
			// 'a' to 'f'
			...newArray(6, (i) => String.fromCharCode('a'.charCodeAt(0) + i)),
		].slice(0, radix),
	)
	if (radix > 10) {
		DigitSet.add('x')
	}
	const DeniedPattern = /^[\u200f]$/iu
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

	ans.note = ans.note.trim()

	ans.value = parseInt(ans.representation, radix)

	if (isNaN(ans.value)) {
		ans.value = 0
	}

	return ans
}

async function registerCommands(
	client: Client<boolean>,
	config: QudahConfig,
	guild: Guild,
	store: Store,
): Promise<void> {
	const clientId = client.user?.id
	if (!clientId) {
		throw new Error('Cannot find client ID.')
	}

	interface Registration {
		command: RESTPostAPIApplicationCommandsJSONBody
		handler: (interaction: ChatInputCommandInteraction) => Awaitable<unknown>
		init?: () => unknown
	}

	const CustomIds = Object.freeze({
		SelectRoles: 'select-roles',
		SelectRolesPrefix: 'select-roles-',
		TurnPagePrefix: 'turn-page-',
	})

	const Registrations: Record<string, Registration> = {
		ping: {
			command: new SlashCommandBuilder()
				.setName('ping')
				.setDescription('ping QUDAH')
				.toJSON(),
			handler: async (interaction) => {
				await interaction.reply({
					content: `Mwah in ${client.ws.ping} ms :kissing_heart:`,
					fetchReply: false,
				})
			},
		},
		sudo: {
			command: new SlashCommandBuilder()
				.setName('sudo')
				.setDescription('For those close to QUDAH')
				.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
				.addSubcommandGroup(
					new SlashCommandSubcommandGroupBuilder()
						.setName('counting')
						.setDescription('Counting related commands')
						.addSubcommand(
							new SlashCommandSubcommandBuilder()
								.setName('get')
								.setDescription('Get the previous value'),
						)
						.addSubcommand(
							new SlashCommandSubcommandBuilder()
								.setName('reset')
								.setDescription('Reset the previous value')
								.addIntegerOption(
									new SlashCommandIntegerOption()
										.setName('value')
										.setDescription('The value to set to')
										.setRequired(false),
								),
						),
				)
				.addSubcommandGroup(
					new SlashCommandSubcommandGroupBuilder()
						.setName('role')
						.setDescription('Role related commands')
						.addSubcommand(
							new SlashCommandSubcommandBuilder()
								.setName('list-categories')
								.setDescription('List existing role categories'),
						)
						.addSubcommand(
							new SlashCommandSubcommandBuilder()
								.setName('order-categories')
								.setDescription('Order existing role categories')
								.addStringOption(
									new SlashCommandStringOption()
										.setName('categories')
										.setDescription('Comma separated list of categories')
										.setRequired(true),
								),
						)
						.addSubcommand(
							new SlashCommandSubcommandBuilder()
								.setName('register-category')
								.setDescription(
									'Register a role category into the QUDAH system',
								)
								.addStringOption(
									new SlashCommandStringOption()
										.setName('category')
										.setDescription('The category of the role')
										.setRequired(true),
								),
						)
						.addSubcommand(
							new SlashCommandSubcommandBuilder()
								.setName('register-role')
								.setDescription('Register a role into the QUDAH system')
								.addStringOption(
									new SlashCommandStringOption()
										.setName('category')
										.setDescription('The category of the role')
										.setChoices(
											...Object.keys(store.roles).map((r) => ({
												name: r,
												value: r,
											})),
										)
										.setRequired(true),
								)
								.addRoleOption(
									new SlashCommandRoleOption()
										.setName('role')
										.setDescription('The role to register')
										.setRequired(true),
								),
						)
						.addSubcommand(
							new SlashCommandSubcommandBuilder()
								.setName('send-prompt')
								.setDescription('Send the role prompt to the current channel')
								.addStringOption(
									new SlashCommandStringOption()
										.setName('content')
										.setDescription('The text content of the prompt')
										.setRequired(true),
								),
						),
				)
				.toJSON(),
			handler: async (interaction) => {
				const subcommandGroup = interaction.options.getSubcommandGroup(true)
				const subcommand = interaction.options.getSubcommand(true)
				if (subcommandGroup === 'counting') {
					if (subcommand === 'get') {
						await interaction.reply({
							content: `\`${store.previous_value}\`; ${formatCountingMessage({
								config,
								value: store.previous_value ?? 0,
							})}.`,
							ephemeral: true,
						})
					} else if (subcommand === 'reset') {
						const value = interaction.options.getInteger('value') ?? 0
						await interaction.reply({
							content: `${formatCountingMessage({ config, value })}`,
						})
					} else if (subcommand === 'register-category') {
						const category = interaction.options.getString('category', true)
						if (!category.match(/^[a-zA-Z0-9]{1,32}$/)) {
							await interaction.reply({
								content: `:x: Category names can only contain 1-32 alphanumeric characters.`,
							})
						} else if (Object.keys(store.roles).length >= MaxCategories) {
							await interaction.reply({
								content: `:x: At most ${MaxCategories} categories can be registered.`,
							})
						} else if (store.roles[category]) {
							await interaction.reply({
								content: `:x: The category '${category}' already exists.`,
							})
						} else {
							store.roles[category] = []
							await interaction.reply({
								content: `:white_check_mark: The category '${category}' has been registered.`,
							})
						}
					} else if (subcommand === 'register-role') {
						const category = interaction.options.getString('category', true)
						const role = interaction.options.getRole('role', true)
						const storeRoles = store.roles[category]
						if (!storeRoles) {
							await interaction.reply({
								content: `:x: Unknown category '${category}'.`,
							})
						} else if (storeRoles.length >= SelectMenuMaxOptions * 4) {
							await interaction.reply({
								content: `:x: No more than ${
									SelectMenuMaxOptions * 4
								} roles can be registered under a single category.`,
							})
						} else if (storeRoles.includes(role.id)) {
							await interaction.reply({
								content: `:x: The role '${role.name}' has already been registered under the category '${category}'.`,
							})
						} else {
							storeRoles.push(role.id)
							await interaction.reply({
								content: `:white_check_mark: The role '${role.name}' has been registered under the category '${category}'.`,
							})
						}
					} else if (subcommand === 'send-prompt') {
						const channel = interaction.channel
						if (!channel) {
							return
						}

						const content = interaction.options.getString('content', true)
						await channel.send({
							allowedMentions: {},
							components: [
								new ActionRowBuilder<ButtonBuilder>().addComponents(
									new ButtonBuilder()
										.setCustomId(CustomIds.SelectRoles)
										.setLabel('Select Roles')
										.setStyle(ButtonStyle.Primary),
								),
							],
							embeds: [
								new EmbedBuilder().setColor('White').setDescription(content),
							],
						})
						await interaction.reply({
							content: 'sent',
							ephemeral: true,
							fetchReply: false,
						})
					}
				} else if (subcommandGroup === 'role') {
					if (subcommand === 'list-categories') {
						await interaction.reply({
							content: `Existing categories: ${Object.keys(store.roles).join(
								', ',
							)}.`,
						})
					} else if (subcommand === 'order-categories') {
						const oldCategories = Object.keys(store.roles)
						const newCategories = interaction.options
							.getString('categories', true)
							.split(/,\s*/)
						if (oldCategories.some((c) => !newCategories.includes(c))) {
							await interaction.reply({
								content: `:x: The following categories are not included: ${oldCategories
									.filter((c) => !newCategories.includes(c))
									.join(', ')}.`,
							})
						} else if (newCategories.some((c) => !oldCategories.includes(c))) {
							await interaction.reply({
								content: `:x: The following categories do not exist: ${newCategories
									.filter((c) => !oldCategories.includes(c))
									.join(', ')}.`,
							})
						} else if (newCategories.length !== oldCategories.length) {
							await interaction.reply({
								content: `:x: Duplicated categories: ${newCategories
									.filter((c, i) => newCategories.indexOf(c) !== i)
									.join(', ')}.`,
							})
						} else {
							store.roles = Object.fromEntries(
								newCategories.map((c) => [c, store.roles[c]!]),
							)
							await interaction.reply({
								content: ':white_check_mark: Ordered categories.',
							})
						}
					} else if (subcommand === 'register-category') {
						const category = interaction.options.getString('category', true)
						if (!category.match(/^[a-zA-Z0-9]{1,32}$/)) {
							await interaction.reply({
								content: `:x: Category names can only contain 1-32 alphanumeric characters.`,
							})
						} else if (Object.keys(store.roles).length >= MaxCategories) {
							await interaction.reply({
								content: `:x: At most ${MaxCategories} categories can be registered.`,
							})
						} else if (store.roles[category]) {
							await interaction.reply({
								content: `:x: The category '${category}' already exists.`,
							})
						} else {
							store.roles[category] = []
							await interaction.reply({
								content: `:white_check_mark: The category '${category}' has been registered.`,
							})
						}
					} else if (subcommand === 'register-role') {
						const category = interaction.options.getString('category', true)
						const role = interaction.options.getRole('role', true)
						const storeRoles = store.roles[category]
						if (!storeRoles) {
							await interaction.reply({
								content: `:x: Unknown category '${category}'.`,
							})
						} else if (storeRoles.length >= SelectMenuMaxOptions * 4) {
							await interaction.reply({
								content: `:x: No more than ${
									SelectMenuMaxOptions * 4
								} roles can be registered under a single category.`,
							})
						} else if (storeRoles.includes(role.id)) {
							await interaction.reply({
								content: `:x: The role '${role.name}' has already been registered under the category '${category}'.`,
							})
						} else {
							storeRoles.push(role.id)
							await interaction.reply({
								content: `:white_check_mark: The role '${role.name}' has been registered under the category '${category}'.`,
							})
						}
					} else if (subcommand === 'send-prompt') {
						const channel = interaction.channel
						if (!channel) {
							return
						}

						const content = interaction.options.getString('content', true)
						await channel.send({
							allowedMentions: {},
							components: [
								new ActionRowBuilder<ButtonBuilder>().addComponents(
									new ButtonBuilder()
										.setCustomId(CustomIds.SelectRoles)
										.setLabel('Select Roles')
										.setStyle(ButtonStyle.Primary),
								),
							],
							embeds: [
								new EmbedBuilder().setColor('White').setDescription(content),
							],
						})
						await interaction.reply({
							content: 'sent',
							ephemeral: true,
							fetchReply: false,
						})
					}
				}
			},
			init: () => {
				client.on('interactionCreate', async (interaction) => {
					if (
						!(
							interaction.isButton() &&
							interaction.customId === CustomIds.SelectRoles
						)
					) {
						return
					}

					try {
						const reply = await interaction.deferReply({
							ephemeral: true,
							fetchReply: true,
						})
						showMenu(interaction, 0, reply)
					} catch (e) {
						console.error('[role selection interaction handler]', e)
					}

					async function showMenu(
						interaction: ButtonInteraction,
						currentCategoryIndex: number,
						reply: Message<boolean>,
					): Promise<void> {
						type RoleOption = { label: string; id: string; selected: boolean }

						try {
							const nonEmptyCategories = Object.entries(store.roles)
								.filter(([, v]) => v.length)
								.map(([k]) => k)
							const category = nonEmptyCategories[currentCategoryIndex]
							if (!category) {
								await sendFinalReply()
								return
							}

							const roleOptions = await getRoleOptions(store.roles[category]!)
							await sendSelectionReply(
								category,
								roleOptions,
								nonEmptyCategories,
							)

							try {
								const subInteraction = await awaitInteraction(category)
								try {
									if (subInteraction.isSelectMenu()) {
										await updateRoles(category, subInteraction.values)
										await showMenu(interaction, currentCategoryIndex + 1, reply)
									} else {
										const nextIndex = parseInt(
											subInteraction.customId.slice(
												CustomIds.TurnPagePrefix.length,
											),
										)
										await showMenu(interaction, nextIndex, reply)
									}
								} catch (e) {
									console.error('[role selection interaction response]', e)
								}
							} catch (_ignored) {
								// Timed out.
								await sendTimeoutReply()
							}
						} catch (e) {
							console.error('[role selection interaction show menu]', e)
						}

						async function getRoleOptions(roleIds: string[]) {
							const ans: RoleOption[] = []
							for (const roleId of roleIds) {
								const role = await guild.roles.fetch(roleId)
								if (role) {
									const member = await guild.members.fetch(interaction.user.id)
									const hasRole = member.roles.cache.has(roleId)
									ans.push({ label: role.name, id: role.id, selected: hasRole })
								} else {
									// The role no longer exists. Remove it from store.
									roleIds.splice(roleIds.indexOf(roleId), 1)
								}
							}
							return ans
						}

						async function sendFinalReply() {
							return interaction.editReply({
								components: [],
								embeds: [
									new EmbedBuilder()
										.setTitle('Role Selection')
										.setColor('DarkGreen')
										.setDescription("You've updated your roles!"),
								],
							})
						}

						async function sendSelectionReply(
							category: string,
							roleOptions: RoleOption[],
							nonEmptyCategories: string[],
						) {
							await interaction.editReply({
								components: [
									new ActionRowBuilder<SelectMenuBuilder>().addComponents(
										new SelectMenuBuilder()
											.setCustomId(`${CustomIds.SelectRolesPrefix}${category}`)
											.setMinValues(0)
											.setMaxValues(roleOptions.length)
											.setOptions(
												...roleOptions
													.sort((a, b) =>
														a.label.toLowerCase() < b.label.toLowerCase()
															? -1
															: 1,
													)
													.map(({ id, label, selected }) =>
														new SelectMenuOptionBuilder()
															.setLabel(label)
															.setValue(id)
															.setDefault(selected),
													),
											),
									),
									new ActionRowBuilder<ButtonBuilder>().addComponents(
										new ButtonBuilder()
											.setCustomId(
												`${CustomIds.TurnPagePrefix}${
													currentCategoryIndex - 1
												}`,
											)
											.setDisabled(currentCategoryIndex === 0)
											.setLabel('◂')
											.setStyle(ButtonStyle.Primary),
										new ButtonBuilder()
											.setCustomId(
												`${CustomIds.TurnPagePrefix}${
													currentCategoryIndex + 1
												}`,
											)
											.setLabel('▸')
											.setStyle(ButtonStyle.Primary),
									),
								],
								embeds: [
									new EmbedBuilder()
										.setTitle('Role Selection')
										.setColor('White')
										.setDescription(
											nonEmptyCategories
												.map(
													(v, i) =>
														`${
															i === currentCategoryIndex ? '__**' : ''
														}${i}. ${v}${
															i === currentCategoryIndex ? '**__' : ''
														}`,
												)
												.join(' > '),
										),
								],
							})
						}

						async function sendTimeoutReply() {
							return interaction.editReply({
								components: [],
								embeds: [
									new EmbedBuilder()
										.setColor('Red')
										.setDescription(':x: Interaction timed out.'),
								],
							})
						}

						async function awaitInteraction(category: string) {
							return await reply.awaitMessageComponent({
								filter: (i) => {
									i.deferUpdate()
									return (
										i.user.id === interaction.user.id &&
										((i.isSelectMenu() &&
											i.customId ===
												`${CustomIds.SelectRolesPrefix}${category}`) ||
											(i.isButton() &&
												i.customId.startsWith(`${CustomIds.TurnPagePrefix}`)))
									)
								},
								time: InteractionTimeoutMs,
							})
						}

						async function updateRoles(category: string, roleIds: string[]) {
							const member = await guild.members.fetch(interaction.user.id)
							const roles = member.roles
							const goodIds = roleIds.filter((id) => !roles.cache.has(id))
							const badIds = [...roles.cache.keys()].filter(
								(id) =>
									store.roles[category]!.includes(id) && !roleIds.includes(id),
							)

							const newMember = badIds.length
								? await roles.remove(badIds, `Remove ${badIds.join(', ')}`)
								: member

							if (goodIds.length) {
								await newMember.roles.add(goodIds, `Add ${goodIds.join(', ')}`)
							}
						}
					}
				})
			},
		},
	}

	// register commands.
	await client.rest.put(
		Routes.applicationGuildCommands(clientId, config.guild),
		{
			body: Object.values(Registrations).map((c) => c.command),
		},
	)

	// register command handlers.
	client.on('interactionCreate', async (interaction) => {
		if (!interaction.isChatInputCommand()) {
			return
		}

		const name = interaction.commandName
		try {
			await Registrations[name]?.handler?.(interaction)
		} catch (e) {
			console.error(`[slash command interaction handler] [${name}]`, e)
		}
	})

	// execute optional initiations.
	for (const { init } of Object.values(Registrations)) {
		init?.()
	}
}

async function countItMyself(
	config: QudahConfig,
	store: Store,
	webhook: Webhook,
) {
	const currentTime = new Date().getTime()
	if (
		store.previous_timestamp !== undefined &&
		store.previous_value !== undefined &&
		currentTime - store.previous_timestamp >= CountItMyselfMinIntervalMs
	) {
		await sendCountingMessage({
			avatarURL: client.user?.displayAvatarURL(),
			config,
			username: client.user?.username,
			value: store.previous_value + 1,
			webhook,
		})
		store.previous_timestamp = currentTime
		store.previous_user = client.user?.id ?? webhook.id
		store.previous_value += 1
	}

	const nextDelayMs = Math.random() * 3 * CountItMyselfBiasMs
	setTimeout(countItMyself.bind(undefined, config, store, webhook), nextDelayMs)
	console.info(
		`[countItMyself] checked at ${currentTime}. next check scheduled in ${nextDelayMs} ms.`,
	)
}

function newArray<T>(size: number, filler: (i: number) => T): T[] {
	return new Array(size).fill(undefined).map((_, i) => filler(i))
}
