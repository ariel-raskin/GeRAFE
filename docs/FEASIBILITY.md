# Feasibility result

**Decision: proceed.** A modern local-first genome browser can provide continuous, map-like pan and zoom while reading real indexed genomics files. The key is to make navigation independent of file access: render immediately from a padded decoded window, then refresh that window asynchronously.

## Test performed

On 2026-09-13, the prototype opened `cutrun_0hr.bw` (228,167,456 bytes) directly from disk. A scripted Chromium run loaded two synthetic tracks and that BigWig, dragged the viewport, zoomed, and checked the browser console.

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

The corrected `Stengel_Raskin/Data` tree was then inventoried and an indexed 489 MB BAM (`External Data/sarah_CR/bams/0hr_A.hg38-only.sorted.bam` plus BAI) was tested through the alignment reader. A 10 kb RUNX1-region smoke test rendered 1,355 coverage/read features, changed correctly when pair and strand-color modes were toggled, and reported no browser errors. A 155 MB PRO-seq TDF was also read directly and returned 19,824 visible signal features without errors.

Finally, the application was compiled as `locus-glide.exe`, launched as a standalone Windows process, and remained running normally. The production executable embeds its interface and does not start a local web server.

## Scope boundary

This result establishes quantitative 1D tracks, TDF compatibility, and BAM coverage/read pileups. BAM queries are limited to 2 Mb, individual reads appear below 250 kb, and deterministic downsampling caps a rendered pileup at 20,000 reads. It does not yet establish performance for CRAM, unusually deep loci, dense variant labels, or 2D contact matrices. Those formats need independent packing, downsampling, and overload-policy benchmarks.

The data lives at `Stengel_Raskin/Data`, two levels above this repository. It contains more than a thousand BigWigs alongside BAM/BAI, VCF/TBI, BED/peak, GTF, TDF, `.cool/.mcool`, and `.hic` files. Files were read in place and were not copied or altered.

## Recommended sequence

1. Move BAM decoding and packing into a worker if many simultaneous alignment tracks exceed the frame budget.
2. Add Tabix-indexed VCF and GTF/GFF-derived annotation tiles.
3. Add reference FASTA/2bit and sequence-level rendering, including reference-assisted mismatch recovery.
4. Implement `.mcool` as a separate GPU matrix track.
6. Stress-test 10, 50, and 100 simultaneous tracks before deciding whether Canvas 2D should be replaced with WebGPU/WebGL.
