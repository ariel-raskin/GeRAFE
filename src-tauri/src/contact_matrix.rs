use gwseq_io::{
    hic::{HiCMode, HiCReader, HiCRequest, Unit},
    open, OpenOptions, Reader,
};
use hdf5_pure::{File as Hdf5File, Group as Hdf5Group};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::SystemTime,
};

const AUTO_TARGET_CELL_PIXELS: f64 = 2.0;
const MAX_MATRIX_BINS: usize = 1_200;
const MAX_CACHED_MATRIX_FILES: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    length: u64,
    modified: Option<SystemTime>,
}

#[derive(Default)]
struct MatrixFileCache {
    hic: HashMap<PathBuf, (FileStamp, Arc<HiCReader>)>,
    cooler: HashMap<PathBuf, (FileStamp, Hdf5File)>,
}

static MATRIX_FILE_CACHE: OnceLock<Mutex<MatrixFileCache>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixChromosome {
    pub name: String,
    pub length: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixMetadata {
    pub format: String,
    pub chromosomes: Vec<MatrixChromosome>,
    pub resolutions: Vec<u64>,
    pub normalizations: Vec<String>,
    pub default_normalization: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixQuery {
    pub path: String,
    pub format: String,
    pub chromosome: String,
    pub start: u64,
    pub end: u64,
    pub pixel_width: usize,
    pub resolution: Option<u64>,
    pub normalization: String,
    pub max_distance: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCell {
    pub bin1: u64,
    pub bin2: u64,
    pub value: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixQueryResult {
    pub resolution: u64,
    pub cells: Vec<MatrixCell>,
}

pub fn metadata(path: &Path, format: &str) -> Result<MatrixMetadata, String> {
    match format {
        "hic" => hic_metadata(path),
        "cool" => cool_metadata(path),
        "mcool" => mcool_metadata(path),
        _ => Err(format!("Unsupported contact matrix format: {format}")),
    }
}

pub fn query(options: MatrixQuery) -> Result<MatrixQueryResult, String> {
    if options.end <= options.start {
        return Err("The contact-matrix query is empty.".into());
    }
    match options.format.as_str() {
        "hic" => query_hic(&options),
        "cool" => query_cool(&options, None),
        "mcool" => query_cool(&options, options.resolution),
        format => Err(format!("Unsupported contact matrix format: {format}")),
    }
}

fn uncached_hic_reader(path: &Path) -> Result<HiCReader, String> {
    match open(
        &path.to_string_lossy(),
        OpenOptions {
            parallel: 1,
            ..Default::default()
        },
    )
    .map_err(|error| format!("Could not open {}: {error}", path.display()))?
    {
        Reader::HiC(reader) => Ok(reader),
        _ => Err(format!("{} is not a .hic contact matrix", path.display())),
    }
}

fn matrix_file_key(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn file_stamp(path: &Path) -> Result<FileStamp, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    Ok(FileStamp {
        length: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn hic_reader(path: &Path) -> Result<Arc<HiCReader>, String> {
    let key = matrix_file_key(path);
    let stamp = file_stamp(path)?;
    let cache = MATRIX_FILE_CACHE.get_or_init(|| Mutex::new(MatrixFileCache::default()));
    if let Some(reader) = cache
        .lock()
        .map_err(|_| "The contact-matrix reader cache is unavailable.".to_string())?
        .hic
        .get(&key)
        .filter(|(cached_stamp, _)| cached_stamp == &stamp)
        .map(|(_, reader)| Arc::clone(reader))
    {
        return Ok(reader);
    }
    let reader = Arc::new(uncached_hic_reader(path)?);
    let mut cache = cache
        .lock()
        .map_err(|_| "The contact-matrix reader cache is unavailable.".to_string())?;
    if cache.hic.len() >= MAX_CACHED_MATRIX_FILES && !cache.hic.contains_key(&key) {
        cache.hic.clear();
    }
    cache.hic.insert(key, (stamp, Arc::clone(&reader)));
    Ok(reader)
}

fn hic_metadata(path: &Path) -> Result<MatrixMetadata, String> {
    let reader = hic_reader(path)?;
    let mut resolutions = reader
        .bin_sizes(Unit::Bp)
        .iter()
        .filter_map(|value| u64::try_from(*value).ok())
        .collect::<Vec<_>>();
    resolutions.sort_unstable();
    resolutions.dedup();
    let mut normalizations = reader
        .normalizations()
        .iter()
        .map(|value| value.to_ascii_uppercase())
        .collect::<Vec<_>>();
    if !normalizations.iter().any(|value| value == "NONE") {
        normalizations.insert(0, "NONE".into());
    }
    normalizations.sort_by_key(|value| normalization_order(value));
    normalizations.dedup();
    let default_normalization = ["KR", "VC_SQRT", "VC", "NONE"]
        .iter()
        .find(|wanted| normalizations.iter().any(|value| value == **wanted))
        .unwrap_or(&"NONE")
        .to_string();
    Ok(MatrixMetadata {
        format: "hic".into(),
        chromosomes: reader
            .chr_sizes()
            .iter()
            .filter(|chromosome| !chromosome.id.eq_ignore_ascii_case("all"))
            .filter_map(|chromosome| {
                u64::try_from(chromosome.size)
                    .ok()
                    .map(|length| MatrixChromosome {
                        name: chromosome.id.clone(),
                        length,
                    })
            })
            .collect(),
        resolutions,
        normalizations,
        default_normalization,
    })
}

fn cool_metadata(path: &Path) -> Result<MatrixMetadata, String> {
    let file = open_cooler(path)?;
    metadata_from_cooler(&file, "", "cool", None)
}

fn mcool_metadata(path: &Path) -> Result<MatrixMetadata, String> {
    let file = open_cooler(path)?;
    let mut resolutions = cooler_resolutions(&file)?;
    resolutions.sort_unstable();
    let default_resolution = *resolutions
        .first()
        .ok_or_else(|| format!("{} has no matrix resolutions", path.display()))?;
    metadata_from_cooler(
        &file,
        &format!("resolutions/{default_resolution}"),
        "mcool",
        Some(resolutions),
    )
}

fn metadata_from_cooler(
    file: &Hdf5File,
    prefix: &str,
    format: &str,
    all_resolutions: Option<Vec<u64>>,
) -> Result<MatrixMetadata, String> {
    let resolution = cooler_resolution(file, prefix)?;
    let bins = file
        .group(&cooler_path(prefix, "bins"))
        .map_err(|error| format!("Could not inspect Cooler bin columns: {error}"))?;
    let mut normalizations = bins
        .datasets()
        .map_err(|error| format!("Could not inspect Cooler normalizations: {error}"))?
        .into_iter()
        .filter(|name| !matches!(name.as_str(), "chrom" | "start" | "end"))
        .collect::<Vec<_>>();
    normalizations.sort_by_key(|name| cooler_normalization_order(name));
    normalizations.dedup();
    normalizations.push("raw".into());
    let default_normalization = normalizations
        .iter()
        .find(|name| name.eq_ignore_ascii_case("weight"))
        .or_else(|| {
            normalizations
                .iter()
                .find(|name| name.eq_ignore_ascii_case("KR"))
        })
        .unwrap_or_else(|| normalizations.last().expect("raw was appended"))
        .clone();
    let names = read_strings(file, &cooler_path(prefix, "chroms/name"))?;
    let lengths = read_u64(file, &cooler_path(prefix, "chroms/length"))?;
    if names.len() != lengths.len() {
        return Err("The Cooler chromosome names and lengths have different sizes.".into());
    }
    Ok(MatrixMetadata {
        format: format.into(),
        chromosomes: names
            .into_iter()
            .zip(lengths)
            .map(|(name, length)| MatrixChromosome { name, length })
            .collect(),
        resolutions: all_resolutions.unwrap_or_else(|| vec![resolution]),
        normalizations,
        default_normalization,
    })
}

fn query_hic(options: &MatrixQuery) -> Result<MatrixQueryResult, String> {
    let reader = hic_reader(Path::new(&options.path))?;
    let available = reader
        .bin_sizes(Unit::Bp)
        .iter()
        .filter_map(|value| u64::try_from(*value).ok())
        .collect::<Vec<_>>();
    let resolution = choose_resolution(
        &available,
        options.resolution,
        options.end - options.start,
        options.pixel_width,
    )?;
    let mut request = HiCRequest::new(
        vec![options.chromosome.clone()],
        vec![options.start as i64],
        vec![options.end as i64],
    );
    request.bin_size = Some(resolution as i64);
    request.full_bin = true;
    request.triangle = true;
    request.normalization = options.normalization.to_ascii_lowercase();
    request.mode = HiCMode::Observed;
    let location = reader
        .parse_loc(&request)
        .map_err(|error| format!("Could not resolve the .hic window: {error}"))?;
    let matrix = reader
        .read_sparse_values(&request)
        .map_err(|error| format!("Could not read .hic contacts: {error}"))?;
    let bin_start = location.x.bin_start;
    let cells = matrix
        .values
        .into_iter()
        .zip(matrix.row)
        .zip(matrix.col)
        .filter_map(|((value, row), col)| {
            let first = (bin_start + row as i64).checked_mul(resolution as i64)?;
            let second = (bin_start + col as i64).checked_mul(resolution as i64)?;
            if !value.is_finite() || value <= 0.0 || first < 0 || second < 0 {
                return None;
            }
            let (bin1, bin2) = ordered_bins(first as u64, second as u64);
            within_distance(bin1, bin2, resolution, options.max_distance).then_some(MatrixCell {
                bin1,
                bin2,
                value: value as f64,
            })
        })
        .collect();
    Ok(MatrixQueryResult { resolution, cells })
}

fn query_cool(
    options: &MatrixQuery,
    selected_resolution: Option<u64>,
) -> Result<MatrixQueryResult, String> {
    let path = Path::new(&options.path);
    let file = open_cooler(path)?;
    let (prefix, resolution) = if options.format == "mcool" {
        let available = cooler_resolutions(&file)?;
        let resolution = choose_resolution(
            &available,
            selected_resolution,
            options.end - options.start,
            options.pixel_width,
        )?;
        (format!("resolutions/{resolution}"), resolution)
    } else {
        let resolution = cooler_resolution(&file, "")?;
        if let Some(selected) = selected_resolution {
            if selected != resolution {
                return Err(format!("The {selected} bp resolution is not available."));
            }
        }
        (String::new(), resolution)
    };

    let names = read_strings(&file, &cooler_path(&prefix, "chroms/name"))?;
    let chromosome_index = names
        .iter()
        .position(|name| name == &options.chromosome)
        .ok_or_else(|| {
            format!(
                "No chromosome named {} in this Cooler file.",
                options.chromosome
            )
        })?;
    let chrom_offsets = read_u64(&file, &cooler_path(&prefix, "indexes/chrom_offset"))?;
    if chromosome_index + 1 >= chrom_offsets.len() {
        return Err("The Cooler chromosome index is incomplete.".into());
    }
    let chromosome_bin_start = chrom_offsets[chromosome_index];
    let chromosome_bin_end = chrom_offsets[chromosome_index + 1];
    let first_bin = (chromosome_bin_start + options.start / resolution).min(chromosome_bin_end);
    let last_bin =
        (chromosome_bin_start + options.end.div_ceil(resolution)).min(chromosome_bin_end);
    if first_bin >= last_bin {
        return Ok(MatrixQueryResult {
            resolution,
            cells: Vec::new(),
        });
    }

    let offsets_dataset = file
        .dataset(&cooler_path(&prefix, "indexes/bin1_offset"))
        .map_err(|error| format!("Could not open Cooler pixel index: {error}"))?;
    let pixel_offsets = offsets_dataset
        .read_u64_rows(first_bin, last_bin - first_bin + 1)
        .map_err(|error| format!("Could not read Cooler pixel index: {error}"))?;
    let pixel_start = *pixel_offsets
        .first()
        .ok_or("The Cooler pixel index is empty.")?;
    let pixel_end = *pixel_offsets
        .last()
        .ok_or("The Cooler pixel index is incomplete.")?;
    let pixel_count = pixel_end.saturating_sub(pixel_start);
    let bin1_ids = read_u64_rows(
        &file,
        &cooler_path(&prefix, "pixels/bin1_id"),
        pixel_start,
        pixel_count,
    )?;
    let bin2_ids = read_u64_rows(
        &file,
        &cooler_path(&prefix, "pixels/bin2_id"),
        pixel_start,
        pixel_count,
    )?;
    let counts = read_f64_rows(
        &file,
        &cooler_path(&prefix, "pixels/count"),
        pixel_start,
        pixel_count,
    )?;
    if bin1_ids.len() != bin2_ids.len() || bin1_ids.len() != counts.len() {
        return Err("The Cooler pixel columns have different sizes.".into());
    }

    // Cooler bin IDs are indexes into the authoritative genomic bin table.
    // Reading the stored starts keeps contact cells aligned to their source
    // coordinates instead of reconstructing them from an assumed origin.
    let bin_starts = read_u64_rows(
        &file,
        &cooler_path(&prefix, "bins/start"),
        first_bin,
        last_bin - first_bin,
    )?;

    let normalized = !options.normalization.eq_ignore_ascii_case("raw");
    let weights = if normalized {
        Some(read_f64_rows(
            &file,
            &cooler_path(&prefix, &format!("bins/{}", options.normalization)),
            first_bin,
            last_bin - first_bin,
        )?)
    } else {
        None
    };
    let divisive = is_divisive_cooler_weight(&options.normalization);
    let cells = bin1_ids
        .into_iter()
        .zip(bin2_ids)
        .zip(counts)
        .filter_map(|((bin1_id, bin2_id), count)| {
            if bin1_id < first_bin
                || bin1_id >= last_bin
                || bin2_id < first_bin
                || bin2_id >= last_bin
            {
                return None;
            }
            let mut value = count;
            if let Some(weights) = &weights {
                let weight1 = *weights.get((bin1_id - first_bin) as usize)?;
                let weight2 = *weights.get((bin2_id - first_bin) as usize)?;
                value = if divisive {
                    value / (weight1 * weight2)
                } else {
                    value * weight1 * weight2
                };
            }
            let first = *bin_starts.get((bin1_id - first_bin) as usize)?;
            let second = *bin_starts.get((bin2_id - first_bin) as usize)?;
            let (bin1, bin2) = ordered_bins(first, second);
            (value.is_finite()
                && value > 0.0
                && within_distance(bin1, bin2, resolution, options.max_distance))
            .then_some(MatrixCell { bin1, bin2, value })
        })
        .collect();
    Ok(MatrixQueryResult { resolution, cells })
}

fn open_cooler(path: &Path) -> Result<Hdf5File, String> {
    let key = matrix_file_key(path);
    let stamp = file_stamp(path)?;
    let cache = MATRIX_FILE_CACHE.get_or_init(|| Mutex::new(MatrixFileCache::default()));
    if let Some(file) = cache
        .lock()
        .map_err(|_| "The contact-matrix reader cache is unavailable.".to_string())?
        .cooler
        .get(&key)
        .filter(|(cached_stamp, _)| cached_stamp == &stamp)
        .map(|(_, file)| file.clone())
    {
        return Ok(file);
    }
    let file = Hdf5File::open_streaming(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut cache = cache
        .lock()
        .map_err(|_| "The contact-matrix reader cache is unavailable.".to_string())?;
    if cache.cooler.len() >= MAX_CACHED_MATRIX_FILES && !cache.cooler.contains_key(&key) {
        cache.cooler.clear();
    }
    cache.cooler.insert(key, (stamp, file.clone()));
    Ok(file)
}

fn ordered_bins(first: u64, second: u64) -> (u64, u64) {
    if first <= second {
        (first, second)
    } else {
        (second, first)
    }
}

fn within_distance(bin1: u64, bin2: u64, resolution: u64, maximum: Option<u64>) -> bool {
    maximum
        .map(|maximum| bin2.saturating_sub(bin1) <= maximum.saturating_add(resolution))
        .unwrap_or(true)
}

fn cooler_resolutions(file: &Hdf5File) -> Result<Vec<u64>, String> {
    let group = file
        .group("resolutions")
        .map_err(|error| format!("Could not open the .mcool resolutions group: {error}"))?;
    let mut resolutions = group
        .groups()
        .map_err(|error| format!("Could not list .mcool resolutions: {error}"))?
        .into_iter()
        .filter_map(|name| name.parse::<u64>().ok())
        .collect::<Vec<_>>();
    resolutions.sort_unstable();
    resolutions.dedup();
    if resolutions.is_empty() {
        return Err("This .mcool file has no numeric resolution groups.".into());
    }
    Ok(resolutions)
}

fn cooler_resolution(file: &Hdf5File, prefix: &str) -> Result<u64, String> {
    let group: Hdf5Group = if prefix.is_empty() {
        file.root()
    } else {
        file.group(prefix)
            .map_err(|error| format!("Could not open the Cooler matrix group: {error}"))?
    };
    let attrs = group
        .attrs()
        .map_err(|error| format!("Could not read Cooler metadata: {error}"))?;
    if let Some(resolution) = attrs.get("bin-size").and_then(|value| value.as_u64()) {
        if resolution > 0 {
            return Ok(resolution);
        }
    }
    let starts = read_u64_rows(file, &cooler_path(prefix, "bins/start"), 0, 1)?;
    let ends = read_u64_rows(file, &cooler_path(prefix, "bins/end"), 0, 1)?;
    match (starts.first(), ends.first()) {
        (Some(start), Some(end)) if end > start => Ok(end - start),
        _ => Err("Variable-bin Cooler files are not yet supported.".into()),
    }
}

fn cooler_path(prefix: &str, suffix: &str) -> String {
    if prefix.is_empty() {
        suffix.to_string()
    } else {
        format!("{prefix}/{suffix}")
    }
}

fn dataset_rows(file: &Hdf5File, path: &str) -> Result<u64, String> {
    let dataset = file
        .dataset(path)
        .map_err(|error| format!("Could not open Cooler dataset {path}: {error}"))?;
    dataset
        .shape()
        .map_err(|error| format!("Could not inspect Cooler dataset {path}: {error}"))?
        .first()
        .copied()
        .ok_or_else(|| format!("Cooler dataset {path} is scalar."))
}

fn read_strings(file: &Hdf5File, path: &str) -> Result<Vec<String>, String> {
    let rows = dataset_rows(file, path)?;
    file.dataset(path)
        .map_err(|error| format!("Could not open Cooler dataset {path}: {error}"))?
        .read_string_rows(0, rows)
        .map_err(|error| format!("Could not read Cooler dataset {path}: {error}"))
}

fn read_u64(file: &Hdf5File, path: &str) -> Result<Vec<u64>, String> {
    let rows = dataset_rows(file, path)?;
    read_u64_rows(file, path, 0, rows)
}

fn read_u64_rows(file: &Hdf5File, path: &str, start: u64, count: u64) -> Result<Vec<u64>, String> {
    file.dataset(path)
        .map_err(|error| format!("Could not open Cooler dataset {path}: {error}"))?
        .read_u64_rows(start, count)
        .map_err(|error| format!("Could not read Cooler dataset {path}: {error}"))
}

fn read_f64_rows(file: &Hdf5File, path: &str, start: u64, count: u64) -> Result<Vec<f64>, String> {
    file.dataset(path)
        .map_err(|error| format!("Could not open Cooler dataset {path}: {error}"))?
        .read_f64_rows(start, count)
        .map_err(|error| format!("Could not read Cooler dataset {path}: {error}"))
}

fn is_divisive_cooler_weight(normalization: &str) -> bool {
    matches!(
        normalization.to_ascii_uppercase().as_str(),
        "KR" | "VC" | "SQRT_VC"
    )
}

fn cooler_normalization_order(value: &str) -> usize {
    match value.to_ascii_lowercase().as_str() {
        "weight" => 0,
        "kr" => 1,
        "vc_sqrt" | "sqrt_vc" => 2,
        "vc" => 3,
        _ => 4,
    }
}

fn choose_resolution(
    available: &[u64],
    selected: Option<u64>,
    span: u64,
    pixel_width: usize,
) -> Result<u64, String> {
    if available.is_empty() {
        return Err("This contact matrix has no base-pair resolutions.".into());
    }
    if let Some(selected) = selected {
        return available
            .iter()
            .copied()
            .find(|value| *value == selected)
            .ok_or_else(|| format!("The {selected} bp resolution is not available."));
    }
    let visible_cells = ((pixel_width.max(1) as f64 / AUTO_TARGET_CELL_PIXELS).round() as usize)
        .clamp(1, MAX_MATRIX_BINS);
    let target = span.div_ceil(visible_cells as u64);
    Ok(available
        .iter()
        .copied()
        .filter(|resolution| *resolution >= target)
        .min()
        .unwrap_or_else(|| *available.iter().max().expect("checked non-empty")))
}

fn normalization_order(value: &str) -> usize {
    match value {
        "KR" => 0,
        "VC_SQRT" => 1,
        "VC" => 2,
        "SCALE" => 3,
        "NONE" => 4,
        _ => 5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_resolution_avoids_subpixel_cells() {
        let available = [1_000, 2_000, 5_000, 10_000];
        assert_eq!(
            choose_resolution(&available, None, 1_000_000, 1_000).unwrap(),
            2_000
        );
        assert_eq!(
            choose_resolution(&available, Some(5_000), 1_000_000, 1_000).unwrap(),
            5_000
        );
    }

    #[test]
    fn configured_real_contact_matrices_open_and_query() {
        for (variable, format) in [
            ("GERAFE_TEST_HIC", "hic"),
            ("GERAFE_TEST_COOL", "cool"),
            ("GERAFE_TEST_MCOOL", "mcool"),
        ] {
            let Ok(path) = std::env::var(variable) else {
                continue;
            };
            let metadata = metadata(Path::new(&path), format)
                .unwrap_or_else(|error| panic!("{variable} metadata failed: {error}"));
            assert!(
                !metadata.resolutions.is_empty(),
                "{variable} has no resolutions"
            );
            let chromosome = metadata
                .chromosomes
                .iter()
                .find(|chromosome| chromosome.length >= 1_000_000)
                .expect("a test matrix should contain a chromosome at least 1 Mb long");
            let span = chromosome.length.min(2_000_000);
            let start = chromosome.length.saturating_sub(span) / 2;
            let result = query(MatrixQuery {
                path,
                format: format.into(),
                chromosome: chromosome.name.clone(),
                start,
                end: start + span,
                pixel_width: 800,
                resolution: None,
                normalization: metadata.default_normalization,
                max_distance: None,
            })
            .unwrap_or_else(|error| panic!("{variable} query failed: {error}"));
            assert!(metadata.resolutions.contains(&result.resolution));
            assert!(result.cells.iter().all(|cell| {
                cell.bin1 + result.resolution > start
                    && cell.bin1 < start + span
                    && cell.bin2 + result.resolution > start
                    && cell.bin2 < start + span
            }));
        }
    }

    #[test]
    fn contact_cells_are_ordered_and_distance_filtered() {
        assert_eq!(ordered_bins(15_000, 5_000), (5_000, 15_000));
        assert!(within_distance(5_000, 15_000, 5_000, Some(5_000)));
        assert!(!within_distance(5_000, 25_000, 5_000, Some(5_000)));
    }

    #[test]
    fn configured_matching_hic_and_cool_use_the_same_genomic_bins() {
        let (Ok(hic_path), Ok(cool_path)) = (
            std::env::var("GERAFE_TEST_MATCHING_HIC"),
            std::env::var("GERAFE_TEST_MATCHING_COOL"),
        ) else {
            return;
        };
        let chromosome = "chr1";
        let start = 109_000_000;
        let end = 111_000_000;
        let query = |path: String, format: &str, normalization: &str| {
            query(MatrixQuery {
                path,
                format: format.into(),
                chromosome: chromosome.into(),
                start,
                end,
                pixel_width: 800,
                resolution: Some(5_000),
                normalization: normalization.into(),
                max_distance: None,
            })
            .unwrap()
        };
        let hic = query(hic_path, "hic", "NONE");
        let cool = query(cool_path, "cool", "raw");
        let hic_bins = hic
            .cells
            .iter()
            .map(|cell| (cell.bin1, cell.bin2))
            .collect::<std::collections::HashSet<_>>();
        let cool_bins = cool
            .cells
            .iter()
            .map(|cell| (cell.bin1, cell.bin2))
            .collect::<std::collections::HashSet<_>>();
        let common = hic_bins.intersection(&cool_bins).count();
        assert!(
            common > 0,
            "the matching matrices had no common contact bins"
        );
        assert!(
            common * 100 >= hic_bins.len().min(cool_bins.len()) * 95,
            "only {common} bins overlapped (hic={}, cool={})",
            hic_bins.len(),
            cool_bins.len()
        );
    }
}
