import { describe, expect, it } from "vitest";
import { ProtobufError } from "../src/codec/protobuf.js";
import { PbWriter } from "./pbWriter.js";
import { decodeWriteRequest, encodeWriteRequest, type RwTimeSeries } from "../src/codec/remoteWrite.js";
import { SnappyError, snappyCompress, snappyDecompress, snappyUncompressedLength } from "../src/codec/snappy.js";
import { Rng } from "../src/loadgen/generator.js";

describe("snappy", () => {
  it("decodes a hand-built literal block", () => {
    const block = Uint8Array.from([5, 4 << 2, ...Buffer.from("hello")]);
    expect(Buffer.from(snappyDecompress(block)).toString()).toBe("hello");
  });

  it("decodes overlapping copies", () => {
    expect(Buffer.from(snappyDecompress(Uint8Array.from([10, 0, 0x61, (5 << 2) | 1, 1]))).toString()).toBe("a".repeat(10));
  });

  it("round-trips random, repetitive and large inputs", () => {
    const rng = new Rng(9);
    const inputs: Uint8Array[] = [
      new Uint8Array(0),
      Buffer.from("abc"),
      Buffer.from("the quick brown fox ".repeat(500)),
      Uint8Array.from({ length: 70_000 }, () => rng.int(256)),
      Uint8Array.from({ length: 200_000 }, (_, i) => (i % 97) ^ (i >> 12))
    ];
    for (const input of inputs) {
      const c = snappyCompress(input);
      expect(snappyUncompressedLength(c)).toBe(input.length);
      expect(Buffer.from(snappyDecompress(c)).equals(Buffer.from(input))).toBe(true);
    }
    const repetitive = Buffer.from("metric_name{host=\"a\"} ".repeat(2000));
    expect(snappyCompress(repetitive).length).toBeLessThan(repetitive.length / 10);
  });

  it("rejects corrupt input and enforces the size limit", () => {
    const c = snappyCompress(Buffer.from("hello world hello world hello world"));
    expect(() => snappyDecompress(c.subarray(0, c.length - 3))).toThrow(SnappyError);
    expect(() => snappyDecompress(Uint8Array.from([4, (3 << 2) | 2, 9, 0]))).toThrow(/offset/);
    expect(() => snappyDecompress(c, 10)).toThrow(/exceeds limit/);
    expect(() => snappyDecompress(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toThrow(/preamble/);
  });
});

describe("remote write protobuf", () => {
  const series: RwTimeSeries[] = [
    {
      labels: [
        ["__name__", "http_requests_total"],
        ["route", "/checkout"],
        ["city", "बेंगलुरु"]
      ],
      samples: [
        { value: 1.5, timestamp: 1_795_000_000_123 },
        { value: NaN, timestamp: 1_795_000_001_123 },
        { value: -Infinity, timestamp: -5 }
      ]
    },
    { labels: [["__name__", "up"]], samples: [{ value: 1, timestamp: 0 }] }
  ];

  it("round-trips series, unicode labels, special floats and negative timestamps", () => {
    const { timeseries, stats } = decodeWriteRequest(encodeWriteRequest(series));
    expect(timeseries).toHaveLength(2);
    expect(timeseries[0]!.labels).toEqual(series[0]!.labels);
    expect(timeseries[0]!.samples[0]).toEqual({ value: 1.5, timestamp: 1_795_000_000_123 });
    expect(Number.isNaN(timeseries[0]!.samples[1]!.value)).toBe(true);
    expect(timeseries[0]!.samples[2]).toEqual({ value: -Infinity, timestamp: -5 });
    expect(stats).toEqual({ skippedExemplars: 0, skippedHistograms: 0 });
  });

  it("matches the generic protobuf writer byte for byte", () => {
    const w = new PbWriter();
    for (const ts of series) {
      w.message(1, (t) => {
        for (const [n, v] of ts.labels) t.message(1, (l) => l.string(1, n).string(2, v));
        for (const s of ts.samples) t.message(2, (m) => m.double(1, s.value).int64(2, s.timestamp));
      });
    }
    expect(Buffer.from(encodeWriteRequest(series)).equals(Buffer.from(w.finish()))).toBe(true);
  });

  it("skips unknown fields, exemplars, histograms and metadata", () => {
    const w = new PbWriter();
    w.message(1, (t) => {
      t.message(1, (l) => l.string(1, "__name__").string(2, "x").int64(7, 99));
      t.message(2, (m) => m.double(1, 2).int64(2, 10));
      t.message(3, (e) => e.double(2, 1));
      t.message(4, (h) => h.int64(1, 3));
      t.int64(9, 1);
    });
    w.message(3, (m) => m.string(2, "meta"));
    const { timeseries, stats } = decodeWriteRequest(w.finish());
    expect(timeseries).toEqual([{ labels: [["__name__", "x"]], samples: [{ value: 2, timestamp: 10 }] }]);
    expect(stats).toEqual({ skippedExemplars: 1, skippedHistograms: 1 });
  });

  it("throws on truncated payloads", () => {
    const bytes = encodeWriteRequest(series);
    expect(() => decodeWriteRequest(bytes.subarray(0, bytes.length - 4))).toThrow(ProtobufError);
    expect(() => decodeWriteRequest(Uint8Array.from([0x0b]))).toThrow(/wire type/);
  });
});
