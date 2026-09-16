use bigtools::{
    bed::bedparser::BedValueError, beddata::BedParserStreamingIterator, BBIProcessError,
    BigWigWrite, InputSortType, Value,
};
use flate2::read::MultiGzDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const CACHE_FORMAT_VERSION: u8 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedBedGraphCache {
    pub path: String,
    pub size: u64,
    pub last_modified: u64,
    pub reused: bool,
}

pub fn prepare(
    source: &Path,
    app_identifier: &str,
    chromosome_sizes: Option<HashMap<String, u32>>,
) -> Result<PreparedBedGraphCache, String> {
    let cache_root = dirs::cache_dir()
        .ok_or_else(|| "Could not locate the operating system cache directory.".to_string())?
        .join(app_identifier)
        .join("bedgraph");
    prepare_at(source, &cache_root, chromosome_sizes)
}

fn prepare_at(
    source: &Path,
    cache_root: &Path,
    chromosome_sizes: Option<HashMap<String, u32>>,
) -> Result<PreparedBedGraphCache, String> {
    let canonical = source
        .canonicalize()
        .map_err(|error| format!("Could not access {}: {error}", source.display()))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("Could not inspect {}: {error}", canonical.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file.", canonical.display()));
    }

    let modified = modified_millis(&metadata);
    let source_key = path_key(&canonical);
    let source_cache = cache_root.join(source_key);
    let cache_name = format!("v{CACHE_FORMAT_VERSION}-{}-{modified}.bw", metadata.len());
    let cache_path = source_cache.join(cache_name);
    if cache_path.is_file() {
        return cache_result(cache_path, true);
    }

    fs::create_dir_all(&source_cache).map_err(|error| {
        format!("Could not create the GeRAFE bedGraph cache directory: {error}")
    })?;
    remove_stale_cache_files(&source_cache, &cache_path)?;

    let compressed = canonical
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("gz"));
    let temporary_path = source_cache.join(format!(
        ".building-{}-{}.bw",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));

    let build_result =
        if let Some(chromosome_sizes) = chromosome_sizes.filter(|sizes| !sizes.is_empty()) {
            match build_bigwig(&canonical, compressed, &temporary_path, chromosome_sizes) {
                Err(BigWigBuildError::MissingChromosome) => {
                    let _ = fs::remove_file(&temporary_path);
                    build_bigwig(
                        &canonical,
                        compressed,
                        &temporary_path,
                        scan_chromosome_sizes(&canonical, compressed)?,
                    )
                }
                result => result,
            }
        } else {
            build_bigwig(
                &canonical,
                compressed,
                &temporary_path,
                scan_chromosome_sizes(&canonical, compressed)?,
            )
        };
    if let Err(error) = build_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error.message(&canonical));
    }
    fs::rename(&temporary_path, &cache_path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        format!("Could not finalize the indexed bedGraph cache: {error}")
    })?;
    cache_result(cache_path, false)
}

fn scan_chromosome_sizes(source: &Path, compressed: bool) -> Result<HashMap<String, u32>, String> {
    let reader = open_reader(source, compressed)?;
    let mut chromosome_sizes = HashMap::new();
    let mut row_count = 0_u64;
    for row in BedGraphRows::new(reader) {
        let (chromosome, value) = row.map_err(|error| error.to_string())?;
        chromosome_sizes
            .entry(chromosome)
            .and_modify(|end: &mut u32| *end = (*end).max(value.end))
            .or_insert(value.end);
        row_count += 1;
    }
    if row_count == 0 {
        return Err("No valid bedGraph rows were found.".to_string());
    }
    Ok(chromosome_sizes)
}

fn build_bigwig(
    source: &Path,
    compressed: bool,
    output: &Path,
    chromosome_sizes: HashMap<String, u32>,
) -> Result<(), BigWigBuildError> {
    let reader = open_reader(source, compressed)?;
    let rows = BedGraphRows::new(reader);
    let values = BedParserStreamingIterator::wrap_iter(rows, true);
    let mut writer = BigWigWrite::create_file(output, chromosome_sizes).map_err(|error| {
        BigWigBuildError::Other(format!(
            "Could not create the indexed bedGraph cache: {error}"
        ))
    })?;
    writer.options.input_sort_type = InputSortType::START;
    let workers = std::thread::available_parallelism()
        .map(|count| count.get().clamp(1, 4))
        .unwrap_or(1);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .build()
        .map_err(|error| {
            BigWigBuildError::Other(format!("Could not start the bedGraph indexer: {error}"))
        })?;
    match writer.write(values, runtime) {
        Ok(()) => Ok(()),
        Err(BBIProcessError::InvalidChromosome(_)) => Err(BigWigBuildError::MissingChromosome),
        Err(error) => Err(BigWigBuildError::Other(error.to_string())),
    }
}

enum BigWigBuildError {
    MissingChromosome,
    Other(String),
}

impl BigWigBuildError {
    fn message(self, source: &Path) -> String {
        let detail = match self {
            Self::MissingChromosome => {
                "the active reference does not include a chromosome used by this file".to_string()
            }
            Self::Other(detail) => detail,
        };
        format!(
            "Could not index {}: {detail}. bedGraph rows must be grouped by chromosome, sorted by start coordinate, and non-overlapping.",
            source.display()
        )
    }
}

impl From<String> for BigWigBuildError {
    fn from(error: String) -> Self {
        Self::Other(error)
    }
}

fn open_reader(source: &Path, compressed: bool) -> Result<Box<dyn BufRead + Send>, String> {
    let file = File::open(source)
        .map_err(|error| format!("Could not open {}: {error}", source.display()))?;
    if compressed {
        Ok(Box::new(BufReader::new(MultiGzDecoder::new(file))))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

struct BedGraphRows<R: BufRead> {
    reader: R,
    line: String,
    line_number: u64,
}

impl<R: BufRead> BedGraphRows<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            line: String::new(),
            line_number: 0,
        }
    }
}

impl<R: BufRead> Iterator for BedGraphRows<R> {
    type Item = Result<(String, Value), BedValueError>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            self.line.clear();
            match self.reader.read_line(&mut self.line) {
                Ok(0) => return None,
                Ok(_) => self.line_number += 1,
                Err(error) => return Some(Err(BedValueError::IoError(error))),
            }
            let line = self.line.trim();
            if line.is_empty()
                || line.starts_with('#')
                || line.starts_with("track")
                || line.starts_with("browser")
            {
                continue;
            }
            return Some(parse_row(line, self.line_number));
        }
    }
}

fn parse_row(line: &str, line_number: u64) -> Result<(String, Value), BedValueError> {
    let mut columns = line.split_whitespace();
    let chromosome = columns
        .next()
        .ok_or_else(|| invalid_row(line_number, "missing chromosome"))?;
    let start = parse_coordinate(columns.next(), line_number, "start")?;
    let end = parse_coordinate(columns.next(), line_number, "end")?;
    let score = columns
        .next()
        .ok_or_else(|| invalid_row(line_number, "missing score"))?
        .parse::<f32>()
        .map_err(|_| invalid_row(line_number, "invalid score"))?;
    if end <= start {
        return Err(invalid_row(
            line_number,
            "end coordinate must be greater than start",
        ));
    }
    if !score.is_finite() {
        return Err(invalid_row(line_number, "score must be finite"));
    }
    Ok((
        chromosome.to_string(),
        Value {
            start,
            end,
            value: score,
        },
    ))
}

fn parse_coordinate(
    value: Option<&str>,
    line_number: u64,
    label: &str,
) -> Result<u32, BedValueError> {
    value
        .ok_or_else(|| invalid_row(line_number, &format!("missing {label} coordinate")))?
        .parse::<u32>()
        .map_err(|_| invalid_row(line_number, &format!("invalid {label} coordinate")))
}

fn invalid_row(line_number: u64, detail: &str) -> BedValueError {
    BedValueError::InvalidInput(format!(
        "Invalid bedGraph row at line {line_number}: {detail}."
    ))
}

fn remove_stale_cache_files(directory: &Path, keep: &Path) -> Result<(), String> {
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect the bedGraph cache: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect the bedGraph cache: {error}"))?;
        if entry.path() == keep
            || !entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        {
            continue;
        }
        fs::remove_file(entry.path())
            .map_err(|error| format!("Could not replace a stale bedGraph cache: {error}"))?;
    }
    Ok(())
}

fn path_key(path: &Path) -> String {
    let mut normalized = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        normalized.make_ascii_lowercase();
    }
    format!("{:x}", Sha256::digest(normalized.as_bytes()))
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn cache_result(path: PathBuf, reused: bool) -> Result<PreparedBedGraphCache, String> {
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect the indexed bedGraph cache: {error}"))?;
    Ok(PreparedBedGraphCache {
        path: path.to_string_lossy().into_owned(),
        size: metadata.len(),
        last_modified: modified_millis(&metadata),
        reused,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    fn unique_test_directory() -> PathBuf {
        std::env::temp_dir().join(format!(
            "gerafe-bedgraph-cache-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn builds_and_reuses_a_gzip_bigwig_cache() {
        let root = unique_test_directory();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("signal.bedGraph.gz");
        let file = File::create(&source).unwrap();
        let mut encoder = GzEncoder::new(file, Compression::default());
        encoder
            .write_all(b"track type=bedGraph\nchr1\t0\t10\t1.5\nchr1\t10\t20\t-2\n")
            .unwrap();
        encoder.finish().unwrap();

        let cache_root = root.join("cache");
        let chromosome_sizes = HashMap::from([("chr1".to_string(), 100)]);
        let first = prepare_at(&source, &cache_root, Some(chromosome_sizes.clone())).unwrap();
        assert!(!first.reused);
        assert!(Path::new(&first.path).is_file());
        assert!(first.size > 64);

        let second = prepare_at(&source, &cache_root, Some(chromosome_sizes.clone())).unwrap();
        assert!(second.reused);
        assert_eq!(second.path, first.path);

        let file = File::create(&source).unwrap();
        let mut encoder = GzEncoder::new(file, Compression::default());
        encoder
            .write_all(b"chr1\t0\t10\t3\nchr1\t10\t30\t4\n")
            .unwrap();
        encoder.finish().unwrap();
        let changed = prepare_at(&source, &cache_root, Some(chromosome_sizes)).unwrap();
        assert!(!changed.reused);
        assert_ne!(changed.path, first.path);
        assert!(!Path::new(&first.path).exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovers_sizes_when_the_reference_lacks_a_chromosome() {
        let root = unique_test_directory();
        fs::create_dir_all(&root).unwrap();
        let source = root.join("alternate.bedGraph.gz");
        let file = File::create(&source).unwrap();
        let mut encoder = GzEncoder::new(file, Compression::default());
        encoder.write_all(b"contigA\t0\t20\t1\n").unwrap();
        encoder.finish().unwrap();

        let unrelated_reference = HashMap::from([("chr1".to_string(), 100)]);
        let cache = prepare_at(&source, &root.join("cache"), Some(unrelated_reference)).unwrap();
        assert!(Path::new(&cache.path).is_file());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_the_line_number_for_invalid_rows() {
        let input = b"# comment\nchr1\t10\t5\t1\n";
        let error = BedGraphRows::new(BufReader::new(input.as_slice()))
            .next()
            .unwrap()
            .unwrap_err()
            .to_string();
        assert!(error.contains("line 2"));
        assert!(error.contains("greater than start"));
    }

    #[test]
    #[ignore = "requires GERAFE_BEDGRAPH_SMOKE_PATH to point to a local real-world file"]
    fn builds_and_reuses_the_real_file_smoke_cache() {
        let source = std::env::var("GERAFE_BEDGRAPH_SMOKE_PATH")
            .expect("GERAFE_BEDGRAPH_SMOKE_PATH must be set");
        let first = prepare(
            Path::new(&source),
            "org.arielraskin.gerafe",
            Some(hg38_chromosome_sizes()),
        )
        .unwrap();
        println!("CACHE_PATH={}", first.path);
        let second = prepare(
            Path::new(&source),
            "org.arielraskin.gerafe",
            Some(hg38_chromosome_sizes()),
        )
        .unwrap();
        assert!(second.reused);
        assert_eq!(second.path, first.path);
    }

    fn hg38_chromosome_sizes() -> HashMap<String, u32> {
        [
            ("chr1", 248_956_422),
            ("chr2", 242_193_529),
            ("chr3", 198_295_559),
            ("chr4", 190_214_555),
            ("chr5", 181_538_259),
            ("chr6", 170_805_979),
            ("chr7", 159_345_973),
            ("chr8", 145_138_636),
            ("chr9", 138_394_717),
            ("chr10", 133_797_422),
            ("chr11", 135_086_622),
            ("chr12", 133_275_309),
            ("chr13", 114_364_328),
            ("chr14", 107_043_718),
            ("chr15", 101_991_189),
            ("chr16", 90_338_345),
            ("chr17", 83_257_441),
            ("chr18", 80_373_285),
            ("chr19", 58_617_616),
            ("chr20", 64_444_167),
            ("chr21", 46_709_983),
            ("chr22", 50_818_468),
            ("chrX", 156_040_895),
            ("chrY", 57_227_415),
            ("chrM", 16_569),
        ]
        .into_iter()
        .map(|(name, length)| (name.to_string(), length))
        .collect()
    }
}
