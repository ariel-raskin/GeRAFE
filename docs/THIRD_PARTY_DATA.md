# Bundled reference data

GeRAFE packages a compact hg38 reference index so that chromosome navigation,
cytobands, gene search, and gene structures work without a network connection.
These files are application data, not original GeRAFE authorship.

## hg38 chromosome sizes

`src/genome.ts` contains the lengths of the GRCh38/hg38 primary chromosomes.
GRCh38 is maintained by the Genome Reference Consortium and distributed through
NCBI and other genome-data providers.

- Assembly: GRCh38/hg38
- NCBI assembly accession: `GCF_000001405`
- NCBI assembly page: https://www.ncbi.nlm.nih.gov/datasets/genome/GCF_000001405.40/

## Cytobands

`static/reference/hg38-cytobands.tsv` is a filtered copy of the UCSC Genome
Browser `cytoBandIdeo` table for hg38. It can be regenerated with:

```powershell
npm run reference:cytobands
```

- Source: https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/cytoBandIdeo.txt.gz
- UCSC data conditions: https://genome.ucsc.edu/conditions.html

UCSC states that its sequence and annotation data are freely available for use,
subject to source-specific restrictions and contributor credit. GeRAFE credits
the UCSC Genome Browser Group as the distributor of this table.

## RefSeq gene and transcript indexes

`static/reference/hg38-refseq-genes.tsv` and the compressed chromosome files in
`static/reference/refseq/` were generated from the UCSC hg38 `ncbiRefSeq` GTF
snapshot dated 2022-10-28. The source field embedded in that GTF is
`ncbiRefSeq.2022-10-28`.

The indexes contain genomic coordinates, strands, gene and transcript
identifiers, exon ranges, and CDS ranges. They do not contain reference sequence
bases or user data. The transcript indexes can be regenerated from a compatible
GTF with:

```powershell
npm run reference:genes -- "C:\path\to\hg38.ncbiRefSeq.gtf"
```

- UCSC RefSeq track description: https://genome.ucsc.edu/cgi-bin/hgTrackUi?db=hg38&g=refSeqComposite
- NCBI RefSeq overview: https://www.ncbi.nlm.nih.gov/refseq/
- NCBI data-usage policy: https://www.ncbi.nlm.nih.gov/home/about/policies/

NCBI places no restrictions of its own on redistribution of molecular database
data, while noting that original submitters may retain rights in contributed
material. Credit NCBI RefSeq and the relevant assembly/data contributors when
using these annotations in publications.

## Updating bundled data

When replacing a bundled reference asset, record the exact upstream URL,
assembly/accession, track or annotation release, and retrieval date in this file
and in the generated asset where practical. Review the upstream conditions before
committing a new data source.
