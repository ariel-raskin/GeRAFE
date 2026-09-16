# Feasibility result

**Decision: proceed.** A modern local-first genome browser can provide continuous, map-like pan and zoom while reading real indexed genomics files. The key is to make navigation independent of file access: render immediately from a padded decoded window, then refresh that window asynchronously.

## Test performed

On 2026-09-13, the prototype opened a representative 218 MB BigWig directly from disk. A scripted Chromium run loaded two synthetic tracks and that BigWig, dragged the viewport, zoomed, and checked the browser console.

On 2026-09-16, GeRAFE streamed a representative 229 MB ordinary-gzip PRO-seq bedGraph (approximately 1.08 GB decompressed) into a 221 MB local BigWig cache without materializing the decompressed text. The initial unoptimized two-pass debug conversion took 192 seconds. After enabling optimized native dependencies and using the active hg38 chromosome sizes for one-pass conversion, a separate uncached 220 MB PRO-seq bedGraph completed in 37.8 seconds, about five times faster. Immediate reopens reused the cache. Twelve 1 Mb queries through the production JavaScript BigWig reader had 3.48–4.10 ms median and 30.28–31.73 ms p95 latency across the two caches.

Results at a 1,440 × 1,000 viewport:

- 3 tracks loaded successfully;
- approximately 6,680 visible signal features;
- 1.1 ms reported canvas draw time after pan and zoom;
- 60 reported interactive frames per second;
- no browser console or page errors.

The standalone BigWig query benchmark used twelve overlapping 1 Mb windows on `chr1`:

- header: 4.05 ms;
- median indexed query: 3.27 ms;
- p95 indexed query: 52.16 ms (the first/cold query);
- 214,574 decoded summary features in total.

These are development-machine measurements, not a general performance guarantee. They are enough to validate the architecture: warm indexed reads are much faster than a frame, the cold read can happen off the interaction path, and rendering the returned data stays well inside a 16.7 ms frame budget.

An indexed 489 MB BAM plus BAI was then tested through the alignment reader. A 10 kb RUNX1-region smoke test rendered 1,355 coverage/read features, changed correctly when pair and strand-color modes were toggled, and reported no browser errors. A 155 MB PRO-seq TDF was also read directly and returned 19,824 visible signal features without errors.

Finally, the application—then using its Locus Glide working name—was compiled as a standalone Windows process and remained running normally. The production executable embeds its interface and does not start a local web server.

## Scope boundary

This result establishes quantitative 1D tracks, TDF compatibility, and BAM coverage/read pileups. BAM queries are limited to 2 Mb, individual reads appear below 250 kb, and deterministic downsampling caps a rendered pileup at 20,000 reads. It does not yet establish performance for CRAM, unusually deep loci, dense variant labels, or 2D contact matrices. Those formats need independent packing, downsampling, and overload-policy benchmarks.

All real-file checks used local research data in place. No source genomics files were copied into or committed to this repository.

## Recommended sequence

1. Move BAM decoding and packing into a worker if many simultaneous alignment tracks exceed the frame budget.
2. Add Tabix-indexed VCF and GTF/GFF-derived annotation tiles.
3. Add reference FASTA/2bit and sequence-level rendering, including reference-assisted mismatch recovery.
4. Implement `.mcool` as a separate GPU matrix track.
6. Stress-test 10, 50, and 100 simultaneous tracks before deciding whether Canvas 2D should be replaced with WebGPU/WebGL.
