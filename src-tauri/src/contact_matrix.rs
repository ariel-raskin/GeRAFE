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
const MAX_EXPECTED_DISTANCE_BINS: usize = 2_000;
const EXPECTED_PIXEL_CHUNK: u64 = 250_000;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct FileStamp {
    length: u64,
    modified: Option<SystemTime>,
}

#[derive(Default)]
struct MatrixFileCache {
    hic: HashMap<PathBuf, (FileStamp, Arc<HiCReader>)>,
    cooler: HashMap<PathBuf, (FileStamp, Hdf5File)>,
    expected: HashMap<ExpectedCacheKey, Arc<Vec<f64>>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ExpectedCacheKey {
    path: PathBuf,
    stamp: FileStamp,
    chromosome: String,
    resolution: u64,
    normalization: String,
    maximum_distance: u64,
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
    pub chromosome2: Option<String>,
    pub start: u64,
    pub end: u64,
    pub start2: Option<u64>,
    pub end2: Option<u64>,
    pub pixel_width: usize,
    pub pixel_height: Option<usize>,
    pub resolution: Option<u64>,
    pub normalization: String,
    pub max_distance: Option<u64>,
    #[serde(default)]
    pub value_mode: MatrixValueMode,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MatrixValueMode {
    #[default]
    Observed,
    ObservedExpected,
    Log2ObservedExpected,
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
pub struct MatrixCellPosition {
    pub bin1: u64,
    pub bin2: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixQueryResult {
    pub resolution: u64,
    pub cells: Vec<MatrixCell>,
    pub missing_cells: Vec<MatrixCellPosition>,
    pub masked_bins: Vec<u64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub masked_bins2: Vec<u64>,
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
    if options.chromosome2.is_some() {
        if options
            .start2
            .zip(options.end2)
            .is_none_or(|(start, end)| end <= start)
        {
            return Err("The second matrix axis must have a nonempty interval.".into());
        }
        if options.value_mode != MatrixValueMode::Observed {
            return Err(
                "Rectangular matrix queries currently support observed contacts only.".into(),
            );
        }
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
    let default_normalization = "NONE".to_string();
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
    let default_normalization = "raw".to_string();
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
    let resolution = if let Some(span2) = options
        .end2
        .zip(options.start2)
        .map(|(end, start)| end - start)
    {
        resolution.max(choose_resolution(
            &available,
            options.resolution,
            span2,
            options.pixel_height.unwrap_or(options.pixel_width),
        )?)
    } else {
        resolution
    };
    let mut request = HiCRequest::new(
        options
            .chromosome2
            .as_ref()
            .map(|second| vec![options.chromosome.clone(), second.clone()])
            .unwrap_or_else(|| vec![options.chromosome.clone()]),
        options
            .start2
            .map(|second| vec![options.start as i64, second as i64])
            .unwrap_or_else(|| vec![options.start as i64]),
        options
            .end2
            .map(|second| vec![options.end as i64, second as i64])
            .unwrap_or_else(|| vec![options.end as i64]),
    );
    request.bin_size = Some(resolution as i64);
    request.full_bin = true;
    request.triangle = options.chromosome2.is_none();
    request.normalization = options.normalization.to_ascii_lowercase();
    request.mode = if options.value_mode == MatrixValueMode::Observed {
        HiCMode::Observed
    } else {
        HiCMode::Oe
    };
    let location = reader
        .parse_loc(&request)
        .map_err(|error| format!("Could not resolve the .hic window: {error}"))?;
    let matrix = reader
        .read_sparse_values(&request)
        .map_err(|error| format!("Could not read .hic contacts: {error}"))?;
    let first_bin_start = if location.reversed {
        location.y.bin_start
    } else {
        location.x.bin_start
    };
    let second_bin_start = if location.reversed {
        location.x.bin_start
    } else {
        location.y.bin_start
    };
    let mut cells = Vec::new();
    let mut missing_cells = Vec::new();
    for ((value, row), col) in matrix.values.into_iter().zip(matrix.row).zip(matrix.col) {
        let Some(first) = (first_bin_start + row as i64).checked_mul(resolution as i64) else {
            continue;
        };
        let Some(second) = (second_bin_start + col as i64).checked_mul(resolution as i64) else {
            continue;
        };
        if first < 0 || second < 0 {
            continue;
        }
        let (bin1, bin2) = if options.chromosome2.is_some() {
            (first as u64, second as u64)
        } else {
            ordered_bins(first as u64, second as u64)
        };
        if options.chromosome2.is_none()
            && !within_distance(bin1, bin2, resolution, options.max_distance)
        {
            continue;
        }
        if !value.is_finite() {
            missing_cells.push(MatrixCellPosition { bin1, bin2 });
        } else if value > 0.0 {
            cells.push(MatrixCell {
                bin1,
                bin2,
                value: transform_matrix_value(value as f64, options.value_mode),
            });
        }
    }
    Ok(MatrixQueryResult {
        resolution,
        cells,
        missing_cells,
        masked_bins: Vec::new(),
        masked_bins2: Vec::new(),
    })
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
        let resolution = if let Some(span2) = options
            .end2
            .zip(options.start2)
            .map(|(end, start)| end - start)
        {
            resolution.max(choose_resolution(
                &available,
                selected_resolution,
                span2,
                options.pixel_height.unwrap_or(options.pixel_width),
            )?)
        } else {
            resolution
        };
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

    if let Some(chromosome2) = &options.chromosome2 {
        return query_cool_rectangle(&file, options, &prefix, resolution, chromosome2);
    }

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
            missing_cells: Vec::new(),
            masked_bins: Vec::new(),
            masked_bins2: Vec::new(),
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
    let expected = if options.value_mode == MatrixValueMode::Observed {
        None
    } else {
        Some(cooler_expected(
            &file,
            options,
            &prefix,
            resolution,
            chromosome_bin_start,
            chromosome_bin_end,
        )?)
    };
    let masked_bins = weights
        .as_ref()
        .map(|weights| masked_bin_starts(weights, &bin_starts))
        .unwrap_or_default();
    let mut cells = Vec::new();
    let mut missing_cells = Vec::new();
    for ((bin1_id, bin2_id), count) in bin1_ids.into_iter().zip(bin2_ids).zip(counts) {
        if bin1_id < first_bin || bin1_id >= last_bin || bin2_id < first_bin || bin2_id >= last_bin
        {
            continue;
        }
        let Some(&first) = bin_starts.get((bin1_id - first_bin) as usize) else {
            continue;
        };
        let Some(&second) = bin_starts.get((bin2_id - first_bin) as usize) else {
            continue;
        };
        let (bin1, bin2) = ordered_bins(first, second);
        if !within_distance(bin1, bin2, resolution, options.max_distance) {
            continue;
        }
        let mut value = count;
        let mut masked = false;
        if let Some(weights) = &weights {
            let Some(&weight1) = weights.get((bin1_id - first_bin) as usize) else {
                continue;
            };
            let Some(&weight2) = weights.get((bin2_id - first_bin) as usize) else {
                continue;
            };
            masked =
                !weight1.is_finite() || weight1 <= 0.0 || !weight2.is_finite() || weight2 <= 0.0;
            if !masked {
                value = if divisive {
                    value / (weight1 * weight2)
                } else {
                    value * weight1 * weight2
                };
            }
        }
        if masked {
            continue;
        }
        if let Some(expected) = &expected {
            let distance = (bin2_id - bin1_id) as usize;
            let denominator = expected.get(distance).copied().unwrap_or(0.0);
            if denominator <= 0.0 || !denominator.is_finite() {
                missing_cells.push(MatrixCellPosition { bin1, bin2 });
                continue;
            }
            value /= denominator;
        }
        if !value.is_finite() {
            missing_cells.push(MatrixCellPosition { bin1, bin2 });
        } else if value > 0.0 {
            cells.push(MatrixCell {
                bin1,
                bin2,
                value: transform_matrix_value(value, options.value_mode),
            });
        }
    }
    Ok(MatrixQueryResult {
        resolution,
        cells,
        missing_cells,
        masked_bins,
        masked_bins2: Vec::new(),
    })
}

fn query_cool_rectangle(
    file: &Hdf5File,
    options: &MatrixQuery,
    prefix: &str,
    resolution: u64,
    chromosome2: &str,
) -> Result<MatrixQueryResult, String> {
    let names = read_strings(file, &cooler_path(prefix, "chroms/name"))?;
    let offsets = read_u64(file, &cooler_path(prefix, "indexes/chrom_offset"))?;
    let range = |name: &str, start: u64, end: u64| -> Result<(u64, u64), String> {
        let index = names
            .iter()
            .position(|item| item == name)
            .ok_or_else(|| format!("No chromosome named {name} in this Cooler file."))?;
        let first = *offsets
            .get(index)
            .ok_or("The Cooler chromosome index is incomplete.")?;
        let last = *offsets
            .get(index + 1)
            .ok_or("The Cooler chromosome index is incomplete.")?;
        Ok((
            (first + start / resolution).min(last),
            (first + end.div_ceil(resolution)).min(last),
        ))
    };
    let (x_start, x_end) = range(&options.chromosome, options.start, options.end)?;
    let (y_start, y_end) = range(chromosome2, options.start2.unwrap(), options.end2.unwrap())?;
    let empty = || MatrixQueryResult {
        resolution,
        cells: Vec::new(),
        missing_cells: Vec::new(),
        masked_bins: Vec::new(),
        masked_bins2: Vec::new(),
    };
    if x_start >= x_end || y_start >= y_end {
        return Ok(empty());
    }
    if x_end - x_start > MAX_MATRIX_BINS as u64 || y_end - y_start > MAX_MATRIX_BINS as u64 {
        return Err("Rectangular matrix queries cannot exceed 1,200 bins on either axis; choose a coarser resolution.".into());
    }
    let x_starts = read_u64_rows(
        file,
        &cooler_path(prefix, "bins/start"),
        x_start,
        x_end - x_start,
    )?;
    let y_starts = read_u64_rows(
        file,
        &cooler_path(prefix, "bins/start"),
        y_start,
        y_end - y_start,
    )?;
    let normalized = !options.normalization.eq_ignore_ascii_case("raw");
    let weight_path = cooler_path(prefix, &format!("bins/{}", options.normalization));
    let (x_weights, y_weights) = if normalized {
        (
            Some(read_f64_rows(file, &weight_path, x_start, x_end - x_start)?),
            Some(read_f64_rows(file, &weight_path, y_start, y_end - y_start)?),
        )
    } else {
        (None, None)
    };
    let masked_bins = x_weights
        .as_ref()
        .map(|weights| masked_bin_starts(weights, &x_starts))
        .unwrap_or_default();
    let masked_bins2 = y_weights
        .as_ref()
        .map(|weights| masked_bin_starts(weights, &y_starts))
        .unwrap_or_default();
    let mut ranges = vec![(x_start, x_end), (y_start, y_end)];
    ranges.sort_unstable();
    if ranges[1].0 <= ranges[0].1 {
        ranges[0].1 = ranges[0].1.max(ranges[1].1);
        ranges.pop();
    }
    let mut result = empty();
    result.masked_bins = masked_bins;
    result.masked_bins2 = masked_bins2;
    let divisive = is_divisive_cooler_weight(&options.normalization);
    for (row_start, row_end) in ranges {
        let offsets = read_u64_rows(
            file,
            &cooler_path(prefix, "indexes/bin1_offset"),
            row_start,
            row_end - row_start + 1,
        )?;
        let first_pixel = *offsets.first().ok_or("The Cooler pixel index is empty.")?;
        let last_pixel = *offsets
            .last()
            .ok_or("The Cooler pixel index is incomplete.")?;
        for chunk_start in (first_pixel..last_pixel).step_by(EXPECTED_PIXEL_CHUNK as usize) {
            let count = (last_pixel - chunk_start).min(EXPECTED_PIXEL_CHUNK);
            let bin1_ids = read_u64_rows(
                file,
                &cooler_path(prefix, "pixels/bin1_id"),
                chunk_start,
                count,
            )?;
            let bin2_ids = read_u64_rows(
                file,
                &cooler_path(prefix, "pixels/bin2_id"),
                chunk_start,
                count,
            )?;
            let values = read_f64_rows(
                file,
                &cooler_path(prefix, "pixels/count"),
                chunk_start,
                count,
            )?;
            if bin1_ids.len() != bin2_ids.len() || bin1_ids.len() != values.len() {
                return Err("The Cooler pixel columns have different sizes.".into());
            }
            for ((first, second), count) in bin1_ids.into_iter().zip(bin2_ids).zip(values) {
                for (x, y) in
                    oriented_rectangular_bins(first, second, (x_start, x_end), (y_start, y_end))
                {
                    let x_index = (x - x_start) as usize;
                    let y_index = (y - y_start) as usize;
                    let (Some(&bin1), Some(&bin2)) = (x_starts.get(x_index), y_starts.get(y_index))
                    else {
                        continue;
                    };
                    let mut value = count;
                    if let (Some(x_weights), Some(y_weights)) = (&x_weights, &y_weights) {
                        let (Some(&weight1), Some(&weight2)) =
                            (x_weights.get(x_index), y_weights.get(y_index))
                        else {
                            continue;
                        };
                        if !weight1.is_finite()
                            || weight1 <= 0.0
                            || !weight2.is_finite()
                            || weight2 <= 0.0
                        {
                            continue;
                        }
                        value = if divisive {
                            value / (weight1 * weight2)
                        } else {
                            value * weight1 * weight2
                        };
                    }
                    if !value.is_finite() {
                        result.missing_cells.push(MatrixCellPosition { bin1, bin2 });
                    } else if value > 0.0 {
                        result.cells.push(MatrixCell { bin1, bin2, value });
                    }
                }
            }
        }
    }
    Ok(result)
}

fn oriented_rectangular_bins(
    first: u64,
    second: u64,
    x: (u64, u64),
    y: (u64, u64),
) -> Vec<(u64, u64)> {
    let mut pairs = Vec::with_capacity(2);
    if first >= x.0 && first < x.1 && second >= y.0 && second < y.1 {
        pairs.push((first, second));
    }
    if first != second && second >= x.0 && second < x.1 && first >= y.0 && first < y.1 {
        pairs.push((second, first));
    }
    pairs
}

fn transform_matrix_value(value: f64, mode: MatrixValueMode) -> f64 {
    if mode == MatrixValueMode::Log2ObservedExpected {
        value.log2()
    } else {
        value
    }
}

fn cooler_expected(
    file: &Hdf5File,
    options: &MatrixQuery,
    prefix: &str,
    resolution: u64,
    chromosome_bin_start: u64,
    chromosome_bin_end: u64,
) -> Result<Arc<Vec<f64>>, String> {
    let chromosome_bins = chromosome_bin_end.saturating_sub(chromosome_bin_start);
    let requested_distance = options
        .max_distance
        .unwrap_or(options.end - options.start)
        .min(options.end - options.start);
    let distance_bins = requested_distance
        .div_ceil(resolution)
        .saturating_add(1)
        .min(chromosome_bins.saturating_sub(1)) as usize;
    if distance_bins > MAX_EXPECTED_DISTANCE_BINS {
        return Err(format!("Observed/expected supports at most {MAX_EXPECTED_DISTANCE_BINS} bins of genomic depth at this resolution. Choose a coarser resolution or shorter depth."));
    }
    let key = ExpectedCacheKey {
        path: matrix_file_key(Path::new(&options.path)),
        stamp: file_stamp(Path::new(&options.path))?,
        chromosome: options.chromosome.clone(),
        resolution,
        normalization: options.normalization.clone(),
        maximum_distance: distance_bins as u64,
    };
    let cache = MATRIX_FILE_CACHE.get_or_init(|| Mutex::new(MatrixFileCache::default()));
    if let Some(values) = cache
        .lock()
        .map_err(|_| "The contact-matrix expected-value cache is unavailable.".to_string())?
        .expected
        .get(&key)
        .cloned()
    {
        return Ok(values);
    }
    let bins = chromosome_bins as usize;
    let weights = if options.normalization.eq_ignore_ascii_case("raw") {
        None
    } else {
        Some(read_f64_rows(
            file,
            &cooler_path(prefix, &format!("bins/{}", options.normalization)),
            chromosome_bin_start,
            chromosome_bins,
        )?)
    };
    let valid = (0..bins)
        .map(|index| {
            weights.as_ref().is_none_or(|weights| {
                weights
                    .get(index)
                    .is_some_and(|weight| weight.is_finite() && *weight > 0.0)
            })
        })
        .collect::<Vec<_>>();
    let counts = expected_pair_counts(&valid, distance_bins);
    let offsets = read_u64_rows(
        file,
        &cooler_path(prefix, "indexes/bin1_offset"),
        chromosome_bin_start,
        chromosome_bins + 1,
    )?;
    let pixel_start = offsets[0];
    let pixel_end = *offsets
        .last()
        .ok_or("The Cooler pixel index is incomplete.")?;
    let divisive = is_divisive_cooler_weight(&options.normalization);
    let mut sums = vec![0.0_f64; distance_bins + 1];
    let mut position = pixel_start;
    while position < pixel_end {
        let count = EXPECTED_PIXEL_CHUNK.min(pixel_end - position);
        let first_ids = read_u64_rows(
            file,
            &cooler_path(prefix, "pixels/bin1_id"),
            position,
            count,
        )?;
        let second_ids = read_u64_rows(
            file,
            &cooler_path(prefix, "pixels/bin2_id"),
            position,
            count,
        )?;
        let values = read_f64_rows(file, &cooler_path(prefix, "pixels/count"), position, count)?;
        if first_ids.len() != second_ids.len() || first_ids.len() != values.len() {
            return Err("The Cooler pixel columns have different sizes.".into());
        }
        for ((first_id, second_id), mut value) in first_ids.into_iter().zip(second_ids).zip(values)
        {
            if first_id < chromosome_bin_start
                || second_id >= chromosome_bin_end
                || second_id < first_id
            {
                continue;
            }
            let first = (first_id - chromosome_bin_start) as usize;
            let second = (second_id - chromosome_bin_start) as usize;
            let distance = second - first;
            if distance > distance_bins || !valid[first] || !valid[second] || !value.is_finite() {
                continue;
            }
            if let Some(weights) = &weights {
                value = if divisive {
                    value / (weights[first] * weights[second])
                } else {
                    value * weights[first] * weights[second]
                };
            }
            if value.is_finite() {
                sums[distance] += value;
            }
        }
        position += count;
    }
    let expected = Arc::new(expected_distance_means(&sums, &counts));
    let mut cache = cache
        .lock()
        .map_err(|_| "The contact-matrix expected-value cache is unavailable.".to_string())?;
    if cache.expected.len() >= MAX_CACHED_MATRIX_FILES {
        cache.expected.clear();
    }
    cache.expected.insert(key, Arc::clone(&expected));
    Ok(expected)
}

fn expected_pair_counts(valid: &[bool], distance_bins: usize) -> Vec<u64> {
    let mut counts = vec![0_u64; distance_bins + 1];
    if valid.iter().all(|valid| *valid) {
        for (distance, count) in counts.iter_mut().enumerate() {
            *count = valid.len().saturating_sub(distance) as u64;
        }
        return counts;
    }
    let mut bits = vec![0_u64; valid.len().div_ceil(64)];
    for (index, present) in valid.iter().enumerate() {
        if *present {
            bits[index / 64] |= 1_u64 << (index % 64);
        }
    }
    for (distance, count) in counts.iter_mut().enumerate() {
        let word_shift = distance / 64;
        let bit_shift = distance % 64;
        for (index, left) in bits.iter().enumerate() {
            let right = bits.get(index + word_shift).copied().unwrap_or(0) >> bit_shift;
            let carry = if bit_shift == 0 {
                0
            } else {
                bits.get(index + word_shift + 1).copied().unwrap_or(0) << (64 - bit_shift)
            };
            *count += (left & (right | carry)).count_ones() as u64;
        }
    }
    counts
}

fn expected_distance_means(sums: &[f64], counts: &[u64]) -> Vec<f64> {
    sums.iter()
        .zip(counts)
        .map(
            |(sum, count)| {
                if *count > 0 {
                    sum / *count as f64
                } else {
                    0.0
                }
            },
        )
        .collect()
}

fn masked_bin_starts(weights: &[f64], bin_starts: &[u64]) -> Vec<u64> {
    weights
        .iter()
        .zip(bin_starts)
        .filter_map(|(weight, start)| (!weight.is_finite() || *weight <= 0.0).then_some(*start))
        .collect()
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
            assert_eq!(
                metadata.default_normalization,
                if format == "hic" { "NONE" } else { "raw" }
            );
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
                path: path.clone(),
                format: format.into(),
                chromosome: chromosome.name.clone(),
                start,
                end: start + span,
                pixel_width: 800,
                pixel_height: None,
                chromosome2: None,
                start2: None,
                end2: None,
                resolution: None,
                normalization: metadata.default_normalization.clone(),
                max_distance: None,
                value_mode: MatrixValueMode::Observed,
            })
            .unwrap_or_else(|error| panic!("{variable} query failed: {error}"));
            assert!(metadata.resolutions.contains(&result.resolution));
            assert!(result.cells.iter().all(|cell| {
                cell.bin1 + result.resolution > start
                    && cell.bin1 < start + span
                    && cell.bin2 + result.resolution > start
                    && cell.bin2 < start + span
            }));
            if let Some(other) = metadata
                .chromosomes
                .iter()
                .find(|other| other.name != chromosome.name && other.length >= 1_000_000)
            {
                let axis2_span = other.length.min(2_000_000);
                let rectangular = query(MatrixQuery {
                    path: path.clone(),
                    format: format.into(),
                    chromosome: chromosome.name.clone(),
                    chromosome2: Some(other.name.clone()),
                    start,
                    end: start + span,
                    start2: Some(0),
                    end2: Some(axis2_span),
                    pixel_width: 400,
                    pixel_height: Some(180),
                    resolution: None,
                    normalization: metadata.default_normalization.clone(),
                    max_distance: None,
                    value_mode: MatrixValueMode::Observed,
                })
                .unwrap_or_else(|error| panic!("{variable} rectangular query failed: {error}"));
                assert!(
                    rectangular.cells.iter().all(|cell| cell.bin1 >= start
                        && cell.bin1 < start + span
                        && cell.bin2 < axis2_span),
                    "{variable} rectangular axis ordering failed"
                );
                let reversed = query(MatrixQuery {
                    path: path.clone(),
                    format: format.into(),
                    chromosome: other.name.clone(),
                    chromosome2: Some(chromosome.name.clone()),
                    start: 0,
                    end: axis2_span,
                    start2: Some(start),
                    end2: Some(start + span),
                    pixel_width: 180,
                    pixel_height: Some(400),
                    resolution: Some(rectangular.resolution),
                    normalization: metadata.default_normalization.clone(),
                    max_distance: None,
                    value_mode: MatrixValueMode::Observed,
                })
                .unwrap_or_else(|error| panic!("{variable} reversed query failed: {error}"));
                let reverse_cells = reversed
                    .cells
                    .iter()
                    .map(|cell| ((cell.bin2, cell.bin1), cell.value))
                    .collect::<HashMap<_, _>>();
                for cell in &rectangular.cells {
                    assert!(
                        reverse_cells
                            .get(&(cell.bin1, cell.bin2))
                            .is_some_and(|other| (other - cell.value).abs() < 0.001),
                        "{variable} reversed query omitted or changed a cell"
                    );
                }
            }
            let normalized = query(MatrixQuery {
                path: path.clone(),
                format: format.into(),
                chromosome: chromosome.name.clone(),
                start,
                end: start + span,
                pixel_width: 800,
                resolution: Some(result.resolution),
                pixel_height: None,
                chromosome2: None,
                start2: None,
                end2: None,
                normalization: metadata.default_normalization.clone(),
                max_distance: Some(100_000),
                value_mode: MatrixValueMode::ObservedExpected,
            })
            .unwrap_or_else(|error| panic!("{variable} observed/expected query failed: {error}"));
            assert!(normalized
                .cells
                .iter()
                .all(|cell| cell.value.is_finite() && cell.value > 0.0));
            let log2 = query(MatrixQuery {
                path: path.clone(),
                format: format.into(),
                chromosome: chromosome.name.clone(),
                start,
                end: start + span,
                pixel_width: 800,
                resolution: Some(result.resolution),
                pixel_height: None,
                chromosome2: None,
                start2: None,
                end2: None,
                normalization: metadata.default_normalization.clone(),
                max_distance: Some(100_000),
                value_mode: MatrixValueMode::Log2ObservedExpected,
            })
            .unwrap_or_else(|error| {
                panic!("{variable} log2 observed/expected query failed: {error}")
            });
            let ratios = normalized
                .cells
                .iter()
                .map(|cell| ((cell.bin1, cell.bin2), cell.value))
                .collect::<HashMap<_, _>>();
            assert!(log2.cells.iter().all(|cell| ratios
                .get(&(cell.bin1, cell.bin2))
                .is_some_and(|ratio| (cell.value - ratio.log2()).abs() < 0.001)));
            if format != "hic"
                && metadata
                    .normalizations
                    .iter()
                    .any(|value| value == "weight")
            {
                let balanced = query(MatrixQuery {
                    path,
                    format: format.into(),
                    chromosome: chromosome.name.clone(),
                    start,
                    end: start + span,
                    pixel_width: 800,
                    resolution: Some(result.resolution),
                    pixel_height: None,
                    chromosome2: None,
                    start2: None,
                    end2: None,
                    normalization: "weight".into(),
                    max_distance: Some(100_000),
                    value_mode: MatrixValueMode::ObservedExpected,
                })
                .unwrap_or_else(|error| {
                    panic!("{variable} balanced observed/expected query failed: {error}")
                });
                assert!(balanced
                    .cells
                    .iter()
                    .all(|cell| cell.value.is_finite() && cell.value > 0.0));
            }
        }
    }

    #[test]
    fn contact_cells_are_ordered_and_distance_filtered() {
        assert_eq!(ordered_bins(15_000, 5_000), (5_000, 15_000));
        assert!(within_distance(5_000, 15_000, 5_000, Some(5_000)));
        assert!(!within_distance(5_000, 25_000, 5_000, Some(5_000)));
    }

    #[test]
    fn invalid_normalization_weights_identify_masked_bins() {
        let weights = [1.0, f64::NAN, 0.0, -1.0, 2.0];
        let starts = [0, 5_000, 10_000, 15_000, 20_000];
        assert_eq!(
            masked_bin_starts(&weights, &starts),
            vec![5_000, 10_000, 15_000]
        );
    }

    #[test]
    fn rectangular_upper_triangle_preserves_chromosome_axis_order() {
        assert_eq!(oriented_rectangular_bins(3, 8, (2, 5), (7, 10)), [(3, 8)]);
        assert_eq!(oriented_rectangular_bins(3, 8, (7, 10), (2, 5)), [(8, 3)]);
        assert_eq!(
            oriented_rectangular_bins(3, 8, (2, 10), (2, 10)),
            [(3, 8), (8, 3)]
        );
        assert_eq!(oriented_rectangular_bins(3, 3, (2, 10), (2, 10)), [(3, 3)]);
    }

    #[test]
    fn expected_means_include_sparse_zero_pairs_and_exclude_masked_bins() {
        let counts = expected_pair_counts(&[true, true, true], 2);
        assert_eq!(counts, [3, 2, 1]);
        assert_eq!(
            expected_distance_means(&[12.0, 6.0, 0.0], &counts),
            [4.0, 3.0, 0.0]
        );
        assert_eq!(expected_pair_counts(&[true, false, true], 2), [2, 0, 1]);
        let mut masked = vec![true; 70];
        masked[2] = false;
        masked[63] = false;
        masked[68] = false;
        let actual = expected_pair_counts(&masked, 69);
        for (distance, count) in actual.iter().enumerate() {
            let brute_force = (0..masked.len() - distance)
                .filter(|index| masked[*index] && masked[index + distance])
                .count() as u64;
            assert_eq!(*count, brute_force, "distance {distance}");
        }
        assert_eq!(
            transform_matrix_value(0.5, MatrixValueMode::Log2ObservedExpected),
            -1.0
        );
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
                pixel_height: None,
                chromosome2: None,
                start2: None,
                end2: None,
                normalization: normalization.into(),
                max_distance: None,
                value_mode: MatrixValueMode::Observed,
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
