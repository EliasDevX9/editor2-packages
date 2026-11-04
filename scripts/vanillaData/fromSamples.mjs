/**
 * Regenerates the vanilla data schemas (packages/minecraftBedrock/schema/general/vanilla)
 * from Mojang's bedrock-samples instead of a Windows Minecraft install.
 *
 * Usage (Node >= 22.6, e.g. Termux `pkg install nodejs`):
 *   node --experimental-strip-types scripts/vanillaData/fromSamples.mjs /path/to/bedrock-samples
 *
 * The folder must contain behavior_pack/, resource_pack/, documentation/ and metadata/.
 * Data is MERGED: values already in the repo are kept and new ones from the samples are added.
 * Sources the samples do not ship (e.g. feature rules, aim assist, worldgen) are left untouched.
 */
import fs from 'node:fs'
import path from 'node:path'
import { toScrape, exportRaw, baseData } from './data.ts'

const samples = process.argv[2]
if (!samples || !fs.existsSync(path.join(samples, 'behavior_pack'))) {
	console.error('Usage: node --experimental-strip-types scripts/vanillaData/fromSamples.mjs <bedrock-samples folder>')
	process.exit(1)
}
const schemaDir = './packages/minecraftBedrock/schema'

// ---------- tolerant JSON ----------
function stripComments(t) {
	let out = '', inStr = false
	for (let i = 0; i < t.length; i++) {
		const c = t[i], n = t[i + 1]
		if (inStr) {
			out += c
			if (c === '\\') out += t[++i]
			else if (c === '"') inStr = false
		} else if (c === '"') { inStr = true; out += c }
		else if (c === '/' && n === '/') { while (i < t.length && t[i] !== '\n') i++; out += '\n' }
		else if (c === '/' && n === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i++; i++ }
		else out += c
	}
	return out
}
function parseJson(text) {
	text = text.replace(/^\uFEFF/, '')
	try { return JSON.parse(text) } catch {}
	return JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, '$1'))
}

// ---------- documentation (HTML tables) ----------
const decode = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim()
function tableColumn(html, tableId, column) {
	const out = []
	let prevEnd = 0, pos = 0
	while (true) {
		const start = html.indexOf('<table', pos)
		if (start < 0) break
		const end = html.indexOf('</table>', start)
		if (end < 0) break
		const before = html.slice(prevEnd, start)
		const heads = [...before.matchAll(/<h[1-6]>([\s\S]*?)<\/h[1-6]>/g)].slice(-2)
		const matches = heads.some((h) => (h[1].match(/<p id="([^"]*)"/) || [])[1] === tableId)
		if (matches) {
			const rows = [...html.slice(start, end).matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1])
			const headers = [...rows[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => decode(m[1]))
			const idx = headers.indexOf(column)
			if (idx >= 0)
				for (const r of rows.slice(1)) {
					const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decode(m[1]))
					if (cells[idx] !== undefined) out.push(cells[idx])
				}
		}
		prevEnd = pos = end + 8
	}
	return out
}

// ---------- game files (samples packs) ----------
function walk(p, data) {
	const parts = p.split('/')
	const key = parts.shift() ?? ''
	let arr = []
	if (key === '*') {
		for (const k in data) {
			if (data[k] && typeof data[k] === 'object') {
				// like the original scraper: a miss adds `undefined` so the container itself is never returned
				arr = arr.concat(walk(parts.join('/'), data[k]))
			} else if (parts.length === 0) arr.push(data[k])
		}
	} else if (data && data[key]) data = walk(parts.join('/'), data[key])
	else if (key !== '') return
	if (arr.length > 0) return arr
	return data
}
function walkJson(p, data) {
	const d = walk(p, data)
	if (d === undefined || d === null) return []
	return Array.isArray(d) ? d : typeof d === 'object' ? Object.keys(d) : [d]
}
function scrapeFile(file, content) {
	if (['.json', '.material'].includes(path.extname(file))) {
		let json
		try { json = parseJson(fs.readFileSync(file, 'utf8')) } catch { return [] }
		return (Array.isArray(content) ? content : [content]).flatMap((c) => walkJson(c, json)).filter((v) => typeof v === 'string')
	}
	const out = []
	for (const line of fs.readFileSync(file, 'utf8').split('\n'))
		for (const c of Array.isArray(content) ? content : [content])
			if (line.match(c)) out.push(line.split('=')[0])
	return out
}
function scrapeDir(full, packPath, content, ext) {
	if (!fs.existsSync(full)) return []
	if (fs.statSync(full).isFile()) return content ? scrapeFile(full, content) : []
	let out = []
	for (const e of fs.readdirSync(full, { withFileTypes: true })) {
		const f = path.join(full, e.name)
		if (e.isDirectory()) out = out.concat(scrapeDir(f, path.posix.join(packPath, e.name), content, ext))
		else if (!content) {
			let p = path.posix.join(packPath, e.name)
			if (!ext) p = p.replace(path.extname(e.name), '')
			out.push(p)
		} else out = out.concat(scrapeFile(f, content))
	}
	return out
}

// ---------- collect ----------
const raw = {}
const add = (id, list) => (raw[id] = (raw[id] ?? []).concat(list))

const docs = {}
for (const t of toScrape.documentation) {
	const page = t.page ?? 'Addons'
	docs[page] ??= fs.readFileSync(path.join(samples, 'documentation', page + '.html'), 'utf8')
	const [tableId, col] = t.target.split('/')
	let d = tableColumn(docs[page], tableId, col)
	if (t.filter) d = d.filter((i) => i && t.filter(i))
	if (t.map) d = d.map((i) => t.map(i))
	add(t.id, d)
}
const skipped = []
for (const t of toScrape.game) {
	if (t.packType === 'definitions') { skipped.push(t.id); continue }
	const base = path.join(samples, t.packType === 'resourcePack' ? 'resource_pack' : 'behavior_pack')
	let d = scrapeDir(path.join(base, t.path), t.path, t.content, t.extensions)
	if (t.filter) d = d.filter((i) => (i ? t.filter(i) : false))
	if (t.map) d = d.map((i) => t.map(i))
	add(t.id, d)
}
// authoritative lists shipped in metadata/vanilladata_modules
const mod = (f) => {
	const p = path.join(samples, 'metadata/vanilladata_modules', f)
	return fs.existsSync(p) ? parseJson(fs.readFileSync(p, 'utf8')).data_items.map((i) => i.name) : []
}
const un = (l) => l.map((i) => i.replace('minecraft:', ''))
const blocks = mod('mojang-blocks.json'), items = mod('mojang-items.json')
const ents = mod('mojang-entities.json').filter((i) => i !== 'minecraft:undefined_test_only')
const biomes = mod('mojang-biomes.json')
add('prefixed_block_identifiers', blocks); add('unprefixed_block_identifiers', un(blocks))
add('prefixed_item_identifiers', items); add('unprefixed_item_identifiers', un(items))
add('prefixed_entity_identifiers', ents); add('unprefixed_entity_identifiers', un(ents))
add('prefixed_biome_identifiers', biomes); add('biome_identifiers', un(biomes))
add('camera_preset_identifiers', mod('mojang-camera-presets.json'))
add('feature_identifiers', mod('mojang-features.json'))

// ---------- merge with existing schemas and write ----------
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null)
const report = []
for (const target of exportRaw) {
	const file = path.join(schemaDir, target.to)
	const old = readJson(file)
	const single = target.from.length === 1
	const merged = {}
	for (const r of target.from) {
		const id = path.basename(r, '.json')
		let prev = []
		if (old) {
			if (single) prev = target.type === 'property' ? Object.keys(old.properties ?? {}) : old.enum ?? []
			else prev = old.definitions?.[id]?.enum ?? []
		}
		merged[id] = [...new Set([...prev, ...(baseData[id] ?? []), ...(raw[id] ?? [])])].filter(Boolean).sort()
		report.push([target.to + (single ? '' : ' :: ' + id), prev.length, merged[id].length])
	}
	const schema = { $schema: 'http://json-schema.org/draft-07/schema' }
	if (single) {
		const l = merged[Object.keys(merged)[0]]
		if (target.type === 'property') Object.assign(schema, { type: 'object', properties: Object.fromEntries(l.map((i) => [i, {}])) })
		else Object.assign(schema, { type: 'string', enum: l })
	} else schema.definitions = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, { type: 'string', enum: v }]))
	fs.writeFileSync(file, JSON.stringify(schema, null, '\t'))
}
let changed = 0
for (const [name, a, b] of report) if (a !== b) { changed++; console.log(`${name}: ${a} -> ${b} (+${b - a})`) }
console.log(`\n${changed} lists updated, ${report.length - changed} unchanged.`)
if (skipped.length) console.log('Not in samples, left untouched:', skipped.join(', '))
