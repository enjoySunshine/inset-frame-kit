import { expect, test } from 'vitest';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	InputVideoTrack,
	MkvOutputFormat,
	Mp4OutputFormat,
	Output,
	OutputFormat,
	Rectangle,
	VideoTrackMetadata,
	WebMOutputFormat,
} from '../../src/index.js';
import { EBMLId } from '../../src/matroska/ebml.js';

// A coded 320x180 clip with a visible region inset by (8, 6) and sized 288x162, and a coded 640x360 clip rotated by
// 90 degrees whose visible region is inset by (24, 12) and sized 560x320. Both must round-trip through MP4 and
// Matroska unchanged, without disturbing any other metadata.
const SMALL = {
	codedWidth: 320,
	codedHeight: 180,
	visibleRect: { left: 8, top: 6, width: 288, height: 162 } as Rectangle,
	spacing: 0.2,
	packetCount: 6,
	firstByte: 30,
	endTimestamp: 1.2,
	probeTimestamp: 0.25,
	probePacketTimestamp: 0.2,
	probeFirstByte: 31,
};

const ROTATED = {
	codedWidth: 640,
	codedHeight: 360,
	visibleRect: { left: 24, top: 12, width: 560, height: 320 } as Rectangle,
	spacing: 0.25,
	packetCount: 4,
	firstByte: 40,
	endTimestamp: 1,
	probeTimestamp: 0.3,
	probePacketTimestamp: 0.25,
	probeFirstByte: 41,
};

for (const [formatName, createFormat] of [
	['MP4', () => new Mp4OutputFormat()],
	['Matroska', () => new MkvOutputFormat()],
] as const) {
	test(`${formatName}: visible region (${SMALL.visibleRect.width}x${SMALL.visibleRect.height})`, async () => {
		using result = await roundTrip(createFormat(), SMALL, {});
		const track = result.track;

		expect(await track.getVisibleRect()).toEqual(SMALL.visibleRect);
		expect(await track.getCodedWidth()).toBe(SMALL.codedWidth);
		expect(await track.getCodedHeight()).toBe(SMALL.codedHeight);
		expect(await track.getDisplayWidth()).toBe(SMALL.codedWidth);
		expect(await track.getDisplayHeight()).toBe(SMALL.codedHeight);
		expect(await track.getRotation()).toBe(0);
		expect(await track.getFlip()).toBe(false);

		await expectColorSpaceAndPackets(track, SMALL);
	});

	test(`${formatName}: visible region with 90 degree rotation`, async () => {
		using result = await roundTrip(createFormat(), ROTATED, { rotation: 90 });
		const track = result.track;

		// The visible region is expressed in coded pixels and must not be swapped by the rotation
		expect(await track.getVisibleRect()).toEqual(ROTATED.visibleRect);
		expect(await track.getCodedWidth()).toBe(ROTATED.codedWidth);
		expect(await track.getCodedHeight()).toBe(ROTATED.codedHeight);
		expect(await track.getDisplayWidth()).toBe(ROTATED.codedHeight);
		expect(await track.getDisplayHeight()).toBe(ROTATED.codedWidth);
		expect(await track.getRotation()).toBe(90);

		await expectColorSpaceAndPackets(track, ROTATED);
	});

	test(`${formatName}: no visible region`, async () => {
		using result = await roundTrip(createFormat(), null, {});
		const track = result.track;

		expect(await track.getVisibleRect()).toBe(null);
		expect(await track.getCodedWidth()).toBe(SMALL.codedWidth);
		expect(await track.getCodedHeight()).toBe(SMALL.codedHeight);
	});
}

test('Visible region of the whole coded frame reads back as none', async () => {
	using result = await roundTrip(new Mp4OutputFormat(), {
		...SMALL,
		visibleRect: { left: 0, top: 0, width: SMALL.codedWidth, height: SMALL.codedHeight },
	}, {});
	const track = result.track;

	expect(await track.getVisibleRect()).toBe(null);
});

test('WebM has no way to store the visible region', async () => {
	using result = await roundTrip(new WebMOutputFormat(), SMALL, {});
	const track = result.track;

	expect(await track.getVisibleRect()).toBe(null);
});

test('Synchronous visibleRect getter', async () => {
	using result = await roundTrip(new Mp4OutputFormat(), SMALL, {});
	const track = result.track;

	// eslint-disable-next-line @typescript-eslint/no-deprecated
	expect(track.visibleRect).toEqual(SMALL.visibleRect);
});

test('Parses an FFmpeg-style clap box with fractional offsets', async () => {
	// FFmpeg's mov_write_clap_tag writes the aperture size and center offset as reduced fractions whose denominators
	// need not be 1, and expresses the offset relative to the coded frame's center. Here the aperture is 288x162
	// centered 8 pixels right and 3 pixels down from the frame center of a 320x180 frame, so the visible region is
	// (8, 6, 288, 162).
	const bytes = await makeMp4WithClap([
		288, 1, // Aperture width
		162, 1, // Aperture height
		-8, 1, // Horizontal offset
		-3, 1, // Vertical offset
	]);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	expect(await track?.getVisibleRect()).toEqual({ left: 8, top: 6, width: 288, height: 162 });
});

test('Fractional clap offsets round to the nearest pixel edge', async () => {
	// A 320x180 frame with a 160x90 aperture shifted right by 4.5 pixels: the aperture center is at x = 164.5, so its
	// left edge lands at 84.5, which rounds to 85.
	const bytes = await makeMp4WithClap([
		160, 1,
		90, 1,
		9, 2, // 4.5
		0, 1,
	]);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	expect(await track?.getVisibleRect()).toEqual({ left: 85, top: 45, width: 160, height: 90 });
});

test('Invalid clap boxes are ignored', async () => {
	// Aperture larger than the coded frame
	const tooLarge = await makeMp4WithClap([400, 1, 162, 1, 0, 1, 0, 1]);
	using input1 = new Input({ source: new BufferSource(tooLarge), formats: ALL_FORMATS });
	expect(await (await input1.getPrimaryVideoTrack())?.getVisibleRect()).toBe(null);

	// Zero denominator
	const zeroDenominator = await makeMp4WithClap([288, 0, 162, 1, 0, 1, 0, 1]);
	using input2 = new Input({ source: new BufferSource(zeroDenominator), formats: ALL_FORMATS });
	expect(await (await input2.getPrimaryVideoTrack())?.getVisibleRect()).toBe(null);
});

test('Invalid visible regions are rejected', () => {
	const addWith = (visibleRect: Rectangle, decoderConfig?: VideoDecoderConfig) => {
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});
		const source = new EncodedVideoPacketSource('vp8');

		return () => output.addVideoTrack(source, { visibleRect, decoderConfig });
	};

	// Zero width
	expect(addWith({ left: 0, top: 0, width: 0, height: 720 })).toThrow();
	// Zero height
	expect(addWith({ left: 0, top: 0, width: 1280, height: 0 })).toThrow();
	// Negative offset
	expect(addWith({ left: -1, top: 0, width: 10, height: 10 })).toThrow();
	// Non-integer value
	expect(addWith({ left: 0, top: 0, width: 10.5, height: 10 })).toThrow();
	// Lies outside the coded frame
	expect(addWith(
		{ left: 1000, top: 0, width: 300, height: 10 },
		{ codec: 'vp8', codedWidth: 1280, codedHeight: 720 },
	)).toThrow();
	expect(addWith(
		{ left: 0, top: 0, width: 1280, height: 721 },
		{ codec: 'vp8', codedWidth: 1280, codedHeight: 720 },
	)).toThrow();
});

const expectColorSpaceAndPackets = async (
	track: InputVideoTrack,
	scenario: typeof SMALL | typeof ROTATED,
) => {
	const colorSpace = await track.getColorSpace();
	expect(colorSpace.primaries).toBe('bt709');
	expect(colorSpace.transfer).toBe('bt709');
	expect(colorSpace.matrix).toBe('bt709');
	expect(colorSpace.fullRange).toBe(false);

	const sink = new EncodedPacketSink(track);
	const packets = [];
	for await (const packet of sink.packets()) {
		packets.push(packet);
	}

	expect(packets).toHaveLength(scenario.packetCount);
	packets.forEach((packet, i) => {
		expect(packet.timestamp).toBeCloseTo(i * scenario.spacing);
	});
	expect(packets.map(packet => packet.data[0])).toEqual(
		Array.from({ length: scenario.packetCount }, (_, i) => scenario.firstByte + i),
	);
	expect(packets.map(packet => packet.type)).toEqual([
		'key',
		...Array.from({ length: scenario.packetCount - 1 }, () => 'delta'),
	]);

	const lastPacket = packets[packets.length - 1]!;
	expect(lastPacket.timestamp + lastPacket.duration).toBeCloseTo(scenario.endTimestamp);

	const probePacket = await sink.getPacket(scenario.probeTimestamp);
	expect(probePacket?.timestamp).toBe(scenario.probePacketTimestamp);
	expect(probePacket?.data[0]).toBe(scenario.probeFirstByte);
};

const roundTrip = async (
	format: OutputFormat,
	scenario: typeof SMALL | typeof ROTATED | null,
	extraMetadata: VideoTrackMetadata,
) => {
	const output = new Output({
		format,
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, {
		...extraMetadata,
		visibleRect: scenario?.visibleRect,
	});

	const dims = scenario ?? SMALL;

	await output.start();
	for (let i = 0; i < dims.packetCount; i++) {
		await source.add(
			new EncodedPacket(
				new Uint8Array([dims.firstByte + i, ...new Uint8Array(1023)]),
				i === 0 ? 'key' : 'delta',
				i * dims.spacing,
				dims.spacing,
			),
			{
				decoderConfig: {
					codec: 'vp8',
					codedWidth: dims.codedWidth,
					codedHeight: dims.codedHeight,
					colorSpace: {
						primaries: 'bt709',
						transfer: 'bt709',
						matrix: 'bt709',
						fullRange: false,
					},
				},
			},
		);
	}
	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	return {
		track,
		[Symbol.dispose]() {
			input.dispose();
		},
	};
};

/**
 * Produces a 320x180 VP8 MP4 file whose video sample entry contains a hand-written `clap` (Clean Aperture) box with
 * the given values, mimicking how FFmpeg and QuickTime write it. The box is spliced into an otherwise normal file and
 * the enclosing boxes' sizes are patched up, so this exercises the demuxer against third-party files.
 */
const makeMp4WithClap = async (values: [
	apertureWidthNum: number,
	apertureWidthDen: number,
	apertureHeightNum: number,
	apertureHeightDen: number,
	horizOffNum: number,
	horizOffDen: number,
	vertOffNum: number,
	vertOffDen: number,
]) => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, {});
	await output.start();
	await source.add(new EncodedPacket(new Uint8Array(64), 'key', 0, 0.2), {
		decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 180 },
	});
	await output.finalize();

	if (!output.target.buffer) {
		throw new Error('No buffer produced.');
	}
	const original = new Uint8Array(output.target.buffer);

	const clap = new Uint8Array(40);
	const clapView = new DataView(clap.buffer);
	clapView.setUint32(0, clap.byteLength, false);
	clap.set([0x63, 0x6c, 0x61, 0x70], 4); // 'clap'
	values.forEach((value, i) => {
		if (i % 2 === 0) {
			// Numerators: the offset numerators are signed, the aperture ones aren't
			const isOffset = i >= 4;
			if (isOffset) {
				clapView.setInt32(8 + 4 * i, value, false);
			} else {
				clapView.setUint32(8 + 4 * i, value, false);
			}
		} else {
			clapView.setUint32(8 + 4 * i, value, false);
		}
	});

	const asString = Array.from(original).map(byte => String.fromCharCode(byte)).join('');
	// The first child box of the video sample entry is 'vpcC'; splice clap in right before it
	const insertionPoint = asString.indexOf('vpcC') - 4;

	const merged = new Uint8Array(original.byteLength + clap.byteLength);
	merged.set(original.subarray(0, insertionPoint), 0);
	merged.set(clap, insertionPoint);
	merged.set(original.subarray(insertionPoint), insertionPoint + clap.byteLength);

	// Grow every enclosing box's size by the size of the inserted box
	const mergedView = new DataView(merged.buffer);
	for (const boxName of ['stsd', 'stbl', 'minf', 'mdia', 'trak', 'moov']) {
		const boxStart = asString.indexOf(boxName) - 4;
		mergedView.setUint32(
			boxStart,
			mergedView.getUint32(boxStart, false) + clap.byteLength,
			false,
		);
	}
	const sampleEntryStart = asString.indexOf('vp08') - 4;
	mergedView.setUint32(
		sampleEntryStart,
		mergedView.getUint32(sampleEntryStart, false) + clap.byteLength,
		false,
	);

	return merged;
};

/**
 * Builds a minimal Matroska file whose single video track has the given pixel dimensions and optional
 * PixelCrop and Display elements, so third-party layouts can be exercised.
 */
const makeMatroska = (options: {
	width: number;
	height: number;
	crop?: { left: number; top: number; right: number; bottom: number };
	displayWidth?: number;
	displayHeight?: number;
	displayUnit?: number;
	docType?: string;
}) => {
	const videoChildren = [
		uintElement(EBMLId.PixelWidth, options.width),
		uintElement(EBMLId.PixelHeight, options.height),
		options.displayWidth === undefined ? null : uintElement(EBMLId.DisplayWidth, options.displayWidth),
		options.displayHeight === undefined ? null : uintElement(EBMLId.DisplayHeight, options.displayHeight),
		options.displayUnit === undefined ? null : uintElement(EBMLId.DisplayUnit, options.displayUnit),
		options.crop?.left ? uintElement(EBMLId.PixelCropLeft, options.crop.left) : null,
		options.crop?.top ? uintElement(EBMLId.PixelCropTop, options.crop.top) : null,
		options.crop?.right ? uintElement(EBMLId.PixelCropRight, options.crop.right) : null,
		options.crop?.bottom ? uintElement(EBMLId.PixelCropBottom, options.crop.bottom) : null,
	];

	const trackEntry = element(
		EBMLId.TrackEntry,
		uintElement(EBMLId.TrackNumber, 1),
		uintElement(EBMLId.TrackType, 1),
		element(EBMLId.CodecID, ascii('V_VP8')),
		element(EBMLId.Video, ...videoChildren),
	);
	const header = element(
		EBMLId.EBML,
		uintElement(EBMLId.EBMLVersion, 1),
		uintElement(EBMLId.EBMLReadVersion, 1),
		element(EBMLId.DocType, ascii(options.docType ?? 'matroska')),
		uintElement(EBMLId.DocTypeVersion, 4),
		uintElement(EBMLId.DocTypeReadVersion, 2),
	);
	const segment = element(
		EBMLId.Segment,
		element(EBMLId.Info, uintElement(EBMLId.TimestampScale, 1e6)),
		element(EBMLId.Tracks, trackEntry),
		element(
			EBMLId.Cluster,
			uintElement(EBMLId.Timestamp, 0),
			element(EBMLId.SimpleBlock, vint(1), u16(0), [0x80], [0x10]),
		),
	);

	return concat(header, segment);
};

test('Matroska: reads a third-party PixelCrop* visible region', async () => {
	const bytes = makeMatroska({
		width: 640,
		height: 360,
		crop: { left: 24, top: 12, right: 56, bottom: 28 },
	});

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	expect(await track?.getVisibleRect()).toEqual({ left: 24, top: 12, width: 560, height: 320 });
});

test('Matroska: PixelCrop* with an invalid region is ignored', async () => {
	const bytes = makeMatroska({
		width: 16,
		height: 16,
		crop: { left: 8, top: 0, right: 8, bottom: 0 },
	});

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	expect(await track?.getVisibleRect()).toBe(null);
});

test('Matroska: DisplayWidth is applied after cropping', async () => {
	// A 320x180 frame cropped to 288x162 and displayed at 576x162: since the display size is relative to the cropped
	// frame, each pixel must be 2 units wide, giving a 2:1 pixel aspect ratio.
	const bytes = makeMatroska({
		width: 320,
		height: 180,
		crop: { left: 8, top: 6, right: 24, bottom: 12 },
		displayWidth: 576,
		displayHeight: 162,
		displayUnit: 0,
	});

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	expect(await track?.getVisibleRect()).toEqual({ left: 8, top: 6, width: 288, height: 162 });
	expect(await track?.getPixelAspectRatio()).toEqual({ num: 2, den: 1 });
});

test('WebM: PixelCrop* is not part of the format and is ignored', async () => {
	const bytes = makeMatroska({
		width: 320,
		height: 180,
		crop: { left: 8, top: 6, right: 24, bottom: 12 },
		docType: 'webm',
	});

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const track = await input.getPrimaryVideoTrack();
	expect(await track?.getVisibleRect()).toBe(null);
});

const concat = (...arrays: Bytes[]) => {
	const parts = arrays
		.filter(part => part !== null)
		.map(part => (typeof part === 'number' ? [part] : Array.from(part)));
	const flattened = parts.flat();
	return new Uint8Array(flattened);
};

type Bytes = (number | Uint8Array | null)[];

const ascii = (text: string) => Array.from(text).map(char => char.charCodeAt(0));

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];

const vint = (value: number) => {
	// Sufficient for the small track numbers used here
	if (value < 0x7f) {
		return [0x80 | value];
	}

	return [0x40 | (value >> 8), value & 0xff];
};

const bigEndian = (value: number, width: number) => {
	const bytes: number[] = [];
	for (let i = width - 1; i >= 0; i--) {
		bytes.push((value >> (8 * i)) & 0xff);
	}
	return bytes;
};

const uintElement = (id: number, value: number) => {
	let width = 1;
	while (value >= 2 ** (8 * width)) {
		width++;
	}

	return element(id, bigEndian(value, width));
};

const elementId = (id: number) => {
	const bytes: number[] = [];
	let value = id;
	while (value > 0) {
		bytes.unshift(value & 0xff);
		value = Math.floor(value / 256);
	}
	return bytes;
};

const elementSize = (size: number) => {
	// Minimal-width EBML variable-size integer
	let width = 1;
	while (size >= 2 ** (7 * width) - 1) {
		width++;
	}

	const bytes = bigEndian(size, width);
	bytes[0]! |= 1 << (8 - width);
	return bytes;
};

const element = (id: number, ...parts: Bytes[]) => {
	const content = concat(...parts);
	return concat(elementId(id), elementSize(content.length), content);
};
