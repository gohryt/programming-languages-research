use anyhow::{Context, Result, anyhow, bail};
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderValue, Method, Request, Response, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use axum_server::Handle;
use brotli::CompressorWriter;
use chrono::Utc;
use clap::Parser;
use flate2::{Compression, write::GzEncoder};
use rustls_acme::{AcmeConfig, caches::DirCache};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::net::TcpListener;
use tokio_stream::StreamExt;
use tower_http::cors::{Any, CorsLayer};
use walkdir::WalkDir;

#[derive(Parser, Debug)]
#[command(name = "programming-languages-research")]
#[command(about = "Validate and serve the programming-languages research corpus")]
struct Cli {
    #[arg(long)]
    build_summary: bool,

    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    #[arg(long, default_value_t = 8000)]
    port: u16,

    #[arg(long, value_delimiter = ',')]
    allowed_host: Vec<String>,

    #[arg(long)]
    email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum RecordKind {
    Language,
    Framework,
    Tool,
    Runtime,
    Concept,
    Library,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SourceLink {
    label: Option<String>,
    url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Reference {
    target: String,
    #[serde(rename = "type")]
    reference_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Backlink {
    source: String,
    #[serde(rename = "type")]
    reference_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Mention {
    alias: String,
    target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Section {
    id: String,
    title: String,
    tags: Vec<String>,
    content: String,
    #[serde(default)]
    refs: Vec<Reference>,
    #[serde(default)]
    sources: Vec<SourceLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    backlinks: Vec<Backlink>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    mentions: Vec<Mention>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: Option<String>,
    kind: RecordKind,
    name: String,
    aliases: Option<Vec<String>>,
    summary: Option<String>,
    sections: Vec<Section>,
    sources: Option<Vec<SourceLink>>,
    provenance: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    derived_tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagDescriptor {
    id: Option<String>,
    tag: String,
    name: String,
    description: Option<String>,
    axis: Option<String>,
    aliases: Option<Vec<String>>,
    parent: Option<String>,
    examples: Option<Vec<String>>,
    sources: Option<Vec<SourceLink>>,
    provenance: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    generated_at: String,
    version: u32,
    records: BTreeMap<String, Record>,
    indexes: Indexes,
    tag_descriptors: BTreeMap<String, TagDescriptor>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Indexes {
    tags: Vec<String>,
    kinds: Vec<String>,
    tag_axes: BTreeMap<String, Vec<String>>,
}

#[derive(Clone)]
struct AppState {
    bundle: Arc<Bundle>,
    static_files: Arc<HashMap<String, StaticFile>>,
    static_dir: Arc<PathBuf>,
    allowed_hosts: Arc<Vec<String>>,
}

#[derive(Debug, Clone)]
struct StaticFile {
    file_path: PathBuf,
    variants: Vec<CompressedVariant>,
}

#[derive(Debug, Clone)]
struct CompressedVariant {
    encoding: &'static str,
    file_path: PathBuf,
    size: u64,
    modified: String,
    etag: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let root = std::env::current_dir().context("resolve working directory")?;
    let static_dir = root.join("static");
    let bundle = if root.join("data").is_dir() {
        let bundle = validate_and_build(&root)?;
        println!(
            "Validated {} record(s), {} tag descriptor(s).",
            bundle.records.len(),
            bundle.tag_descriptors.len()
        );
        write_static_bundle(&static_dir, &bundle)?;
        bundle
    } else if cli.build_summary {
        bail!(
            "Cannot build summary because {} is missing",
            root.join("data").display()
        );
    } else {
        load_static_bundle(&static_dir)?
    };
    let static_files = precompress_static(&static_dir)?;
    if cli.build_summary {
        return Ok(());
    }

    let state = AppState {
        bundle: Arc::new(bundle),
        static_files: Arc::new(static_files),
        static_dir: Arc::new(static_dir),
        allowed_hosts: Arc::new(cli.allowed_host),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any);
    let app = Router::new()
        .route(
            "/mcp",
            post(mcp_post)
                .get(mcp_method_not_allowed)
                .delete(mcp_method_not_allowed),
        )
        .route("/{*path}", get(static_get).head(static_get))
        .route("/", get(static_get).head(static_get))
        .layer(cors)
        .with_state(state);

    let address: SocketAddr = format!("{}:{}", cli.host, cli.port)
        .parse()
        .with_context(|| format!("parse listen address {}:{}", cli.host, cli.port))?;
    println!("Serving {}", root.join("static").display());

    if let Some(domain) = acme_domain(&cli.host) {
        let email = cli
            .email
            .clone()
            .ok_or_else(|| anyhow!("--email is required when --host is a public hostname"))?;
        let cache_dir = root.join(".acme").join(&domain);
        fs::create_dir_all(&cache_dir)?;
        println!("Open https://{}:{}", cli.host, cli.port);
        println!("MCP endpoint: https://{}:{}/mcp (POST)", cli.host, cli.port);
        println!("TLS: auto (Let's Encrypt) for {}", domain);
        serve_with_acme(address, app, cache_dir, domain, email).await?;
    } else {
        let listener = TcpListener::bind(address).await?;
        println!("Open http://{}", address);
        println!("MCP endpoint: http://{}/mcp (POST)", address);
        println!("TLS: off (plain HTTP)");
        axum::serve(listener, app).await?;
    }
    Ok(())
}

fn is_hostname_like(host: &str) -> bool {
    !host.is_empty()
        && host != "localhost"
        && host != "0.0.0.0"
        && host != "::"
        && host.contains('.')
        && !host.ends_with(".local")
        && host.parse::<std::net::IpAddr>().is_err()
}

fn acme_domain(host: &str) -> Option<String> {
    if is_hostname_like(host) {
        Some(host.to_string())
    } else {
        None
    }
}

async fn serve_with_acme(
    address: SocketAddr,
    app: Router,
    cache_dir: PathBuf,
    domain: String,
    email: String,
) -> Result<()> {
    let mut state = AcmeConfig::new([domain])
        .contact([format!("mailto:{}", email)])
        .cache(DirCache::new(cache_dir))
        .directory_lets_encrypt(true)
        .state();
    let acceptor = state.axum_acceptor(state.default_rustls_config());
    tokio::spawn(async move {
        while let Some(result) = state.next().await {
            match result {
                Ok(event) => println!("[acme] {:?}", event),
                Err(error) => eprintln!("[acme] {}", error),
            }
        }
    });
    axum_server::bind(address)
        .acceptor(acceptor)
        .handle(Handle::new())
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

fn validate_and_build(root: &Path) -> Result<Bundle> {
    let data_dir = root.join("data");
    let tags_dir = root.join("tags");
    let mut records = load_records(&data_dir)?;
    let tag_descriptors = load_tags(&tags_dir)?;
    summarize_records(&mut records)?;
    check_tag_descriptors(&tag_descriptors, &records)?;
    let indexes = collect_indexes(&records, &tag_descriptors);
    Ok(Bundle {
        generated_at: chrono_like_now(),
        version: 1,
        records,
        indexes,
        tag_descriptors,
    })
}

fn chrono_like_now() -> String {
    Utc::now().to_rfc3339()
}

fn load_static_bundle(static_dir: &Path) -> Result<Bundle> {
    let data_path = static_dir.join("data.json");
    let bundle: Bundle = serde_json::from_value(read_json(&data_path)?)
        .with_context(|| format!("parse generated bundle {}", data_path.display()))?;
    println!(
        "Loaded {} record(s), {} tag descriptor(s) from {}.",
        bundle.records.len(),
        bundle.tag_descriptors.len(),
        data_path.display()
    );
    Ok(bundle)
}

fn read_json(path: &Path) -> Result<Value> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn load_records(data_dir: &Path) -> Result<BTreeMap<String, Record>> {
    let mut records = BTreeMap::new();
    let mut files: Vec<PathBuf> = fs::read_dir(data_dir)
        .with_context(|| format!("read data directory {}", data_dir.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    for path in files {
        let id = path.file_stem().unwrap().to_string_lossy().to_string();
        let record: Record = serde_json::from_value(read_json(&path)?)
            .with_context(|| format!("parse record {}", path.display()))?;
        if let Some(explicit_id) = &record.id
            && explicit_id != &id
        {
            bail!(
                "Top-level id {} does not match filename {}.json",
                explicit_id,
                id
            );
        }
        let mut seen = HashSet::new();
        for section in &record.sections {
            if !seen.insert(section.id.clone()) {
                bail!("Duplicate section id in {}: {}", id, section.id);
            }
        }
        validate_record_shape(&id, &record)?;
        records.insert(id, record);
    }
    Ok(records)
}

fn validate_record_shape(record_id: &str, record: &Record) -> Result<()> {
    let kebab = |value: &str| {
        !value.is_empty()
            && value.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
            })
    };
    let tag_pattern = |value: &str| {
        let parts: Vec<&str> = value.split(':').collect();
        parts.len() <= 2 && parts.iter().all(|part| kebab(part))
    };
    let valid_kinds = matches!(
        record.kind,
        RecordKind::Language
            | RecordKind::Framework
            | RecordKind::Tool
            | RecordKind::Runtime
            | RecordKind::Concept
            | RecordKind::Library
    );
    if !valid_kinds {
        bail!("Invalid kind in {}", record_id);
    }
    if record.name.is_empty() {
        bail!("Record {} has empty name", record_id);
    }
    if record.sections.is_empty() {
        bail!("Record {} has no sections", record_id);
    }
    for section in &record.sections {
        if !kebab(&section.id) {
            bail!("Record {} has invalid section id {}", record_id, section.id);
        }
        if section.title.is_empty() {
            bail!("Record {}#{} has empty title", record_id, section.id);
        }
        for tag in &section.tags {
            if !tag_pattern(tag) {
                bail!(
                    "Record {}#{} has invalid tag {}",
                    record_id,
                    section.id,
                    tag
                );
            }
        }
        for reference in &section.refs {
            let (target_record, target_section) = split_target(&reference.target);
            if !kebab(&target_record) || target_section.as_deref().is_some_and(|id| !kebab(id)) {
                bail!(
                    "Record {}#{} has invalid ref target {}",
                    record_id,
                    section.id,
                    reference.target
                );
            }
            if !kebab(&reference.reference_type) {
                bail!(
                    "Record {}#{} has invalid ref type {}",
                    record_id,
                    section.id,
                    reference.reference_type
                );
            }
        }
    }
    Ok(())
}

fn tag_to_id(tag: &str) -> String {
    tag.replace(':', "-")
}

fn tag_axis(tag: &str) -> Option<String> {
    tag.find(':').map(|index| tag[..index].to_string())
}

fn load_tags(tags_dir: &Path) -> Result<BTreeMap<String, TagDescriptor>> {
    let mut tags = BTreeMap::new();
    if !tags_dir.exists() {
        return Ok(tags);
    }
    let mut files: Vec<PathBuf> = fs::read_dir(tags_dir)?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    for path in files {
        let id = path.file_stem().unwrap().to_string_lossy().to_string();
        let mut descriptor: TagDescriptor = serde_json::from_value(read_json(&path)?)
            .with_context(|| format!("parse tag descriptor {}", path.display()))?;
        if let Some(explicit_id) = &descriptor.id
            && explicit_id != &id
        {
            bail!(
                "Tag descriptor id {} does not match filename {}.json",
                explicit_id,
                id
            );
        }
        if tag_to_id(&descriptor.tag) != id {
            bail!(
                "Tag {} should map to filename {}.json",
                descriptor.tag,
                tag_to_id(&descriptor.tag)
            );
        }
        validate_tag_shape(&id, &descriptor)?;
        descriptor.id = Some(id);
        tags.insert(descriptor.tag.clone(), descriptor);
    }
    Ok(tags)
}

fn validate_tag_shape(id: &str, descriptor: &TagDescriptor) -> Result<()> {
    let kebab = |value: &str| {
        !value.is_empty()
            && value.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
            })
    };
    let tag_pattern = |value: &str| {
        let parts: Vec<&str> = value.split(':').collect();
        parts.len() <= 2 && parts.iter().all(|part| kebab(part))
    };
    if !kebab(id) || !tag_pattern(&descriptor.tag) || descriptor.name.is_empty() {
        bail!("Invalid tag descriptor {}", id);
    }
    if let Some(axis) = &descriptor.axis
        && !kebab(axis)
    {
        bail!("Invalid axis {} in tag descriptor {}", axis, id);
    }
    Ok(())
}

fn summarize_records(records: &mut BTreeMap<String, Record>) -> Result<()> {
    let alias_index = build_alias_index(records)?;
    let record_ids: HashSet<String> = records.keys().cloned().collect();
    let section_ids: HashMap<String, HashSet<String>> = records
        .iter()
        .map(|(id, record)| {
            (
                id.clone(),
                record
                    .sections
                    .iter()
                    .map(|section| section.id.clone())
                    .collect(),
            )
        })
        .collect();
    let mut backlinks: HashMap<String, Vec<Backlink>> = HashMap::new();

    for (record_id, record) in records.iter_mut() {
        let mut derived = BTreeSet::new();
        for section in &mut record.sections {
            section.anchor = Some(format!("{}#{}", record_id, section.id));
            section.sources = std::mem::take(&mut section.sources);
            section.refs = std::mem::take(&mut section.refs);
            section.backlinks.clear();
            section.mentions = derive_mentions(section, &alias_index, record_id);
            for tag in &section.tags {
                derived.insert(tag.clone());
            }
            for reference in &section.refs {
                let (target_record, target_section) = split_target(&reference.target);
                if !record_ids.contains(&target_record) {
                    bail!(
                        "Unresolved ref in {}#{}: Unknown target record: {}",
                        record_id,
                        section.id,
                        target_record
                    );
                }
                if let Some(target_section) = target_section {
                    if !section_ids
                        .get(&target_record)
                        .is_some_and(|sections| sections.contains(&target_section))
                    {
                        bail!(
                            "Unresolved ref in {}#{}: Unknown target section: {}#{}",
                            record_id,
                            section.id,
                            target_record,
                            target_section
                        );
                    }
                    backlinks
                        .entry(reference.target.clone())
                        .or_default()
                        .push(Backlink {
                            source: format!("{}#{}", record_id, section.id),
                            reference_type: reference.reference_type.clone(),
                        });
                }
            }
        }
        record.derived_tags = derived.into_iter().collect();
    }

    for record in records.values_mut() {
        for section in &mut record.sections {
            let anchor = section.anchor.clone().unwrap_or_default();
            section.backlinks = backlinks.remove(&anchor).unwrap_or_default();
            section
                .backlinks
                .sort_by(|left, right| left.source.cmp(&right.source));
        }
    }
    Ok(())
}

fn split_target(target: &str) -> (String, Option<String>) {
    let mut parts = target.splitn(2, '#');
    (
        parts.next().unwrap_or_default().to_string(),
        parts.next().map(ToString::to_string),
    )
}

fn build_alias_index(records: &BTreeMap<String, Record>) -> Result<HashMap<String, String>> {
    let mut alias_index = HashMap::new();
    for (record_id, record) in records {
        let mut names = vec![record.name.clone()];
        names.extend(record.aliases.clone().unwrap_or_default());
        for name in names {
            let normalized = name.trim().to_lowercase();
            if normalized.is_empty() {
                continue;
            }
            if let Some(existing) = alias_index.get(&normalized)
                && existing != record_id
            {
                bail!(
                    "Alias collision for {}: {} and {}",
                    name,
                    record_id,
                    existing
                );
            }
            alias_index.insert(normalized, record_id.clone());
        }
    }
    Ok(alias_index)
}

fn derive_mentions(
    section: &Section,
    alias_index: &HashMap<String, String>,
    record_id: &str,
) -> Vec<Mention> {
    let content = section.content.to_lowercase();
    let mut mentions = Vec::new();
    let mut seen_targets = HashSet::new();
    for (alias, target_record_id) in alias_index {
        if target_record_id == record_id {
            continue;
        }
        if contains_word(&content, alias) && seen_targets.insert(target_record_id.clone()) {
            mentions.push(Mention {
                alias: alias.clone(),
                target: format!("{}#overview", target_record_id),
            });
        }
    }
    mentions.sort_by(|left, right| left.alias.cmp(&right.alias));
    mentions
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    let mut start = 0;
    while let Some(offset) = haystack[start..].find(needle) {
        let index = start + offset;
        let before = haystack[..index].chars().next_back();
        let after = haystack[index + needle.len()..].chars().next();
        if before.is_none_or(|ch| !is_word_char(ch)) && after.is_none_or(|ch| !is_word_char(ch)) {
            return true;
        }
        start = index + needle.len();
    }
    false
}

fn is_word_char(character: char) -> bool {
    character == '_' || character.is_ascii_alphanumeric()
}

fn check_tag_descriptors(
    descriptors: &BTreeMap<String, TagDescriptor>,
    records: &BTreeMap<String, Record>,
) -> Result<()> {
    let used: HashSet<String> = records
        .values()
        .flat_map(|record| record.sections.iter())
        .flat_map(|section| section.tags.iter().cloned())
        .collect();
    for descriptor in descriptors.values() {
        if let Some(parent) = &descriptor.parent
            && !descriptors.contains_key(parent)
        {
            bail!(
                "Tag {} has parent {} which has no descriptor",
                descriptor.tag,
                parent
            );
        }
        for alias in descriptor.aliases.clone().unwrap_or_default() {
            if used.contains(&alias) {
                bail!(
                    "Tag {} is still in use but is declared as alias of {}",
                    alias,
                    descriptor.tag
                );
            }
        }
    }
    Ok(())
}

fn collect_indexes(
    records: &BTreeMap<String, Record>,
    descriptors: &BTreeMap<String, TagDescriptor>,
) -> Indexes {
    let mut tags = BTreeSet::new();
    let mut kinds = BTreeSet::new();
    for record in records.values() {
        kinds.insert(format!("{:?}", record.kind).to_lowercase());
        for section in &record.sections {
            for tag in &section.tags {
                tags.insert(tag.clone());
            }
        }
    }
    let tags_vec: Vec<String> = tags.iter().cloned().collect();
    let mut tag_axes: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for tag in &tags_vec {
        if let Some(axis) = tag_axis(tag) {
            tag_axes.entry(axis).or_default().insert(tag.clone());
        }
    }
    for descriptor in descriptors.values() {
        if let Some(axis) = &descriptor.axis
            && tag_axis(&descriptor.tag).as_deref() == Some(axis)
        {
            tag_axes
                .entry(axis.clone())
                .or_default()
                .insert(descriptor.tag.clone());
        }
    }
    Indexes {
        tags: tags_vec,
        kinds: kinds.into_iter().collect(),
        tag_axes: tag_axes
            .into_iter()
            .map(|(axis, values)| (axis, values.into_iter().collect()))
            .collect(),
    }
}

fn write_static_bundle(static_dir: &Path, bundle: &Bundle) -> Result<()> {
    fs::create_dir_all(static_dir)?;
    let data = serde_json::to_string_pretty(bundle)?;
    fs::write(static_dir.join("data.json"), format!("{}\n", data))?;
    println!("Wrote {}", static_dir.join("data.json").display());
    Ok(())
}

fn precompress_static(static_dir: &Path) -> Result<HashMap<String, StaticFile>> {
    let mut files = HashMap::new();
    for entry in WalkDir::new(static_dir).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let name = path.file_name().unwrap().to_string_lossy();
        if name.ends_with(".gz") || name.ends_with(".br") {
            continue;
        }
        let data = fs::read(path)?;
        let gzip_path = path.with_file_name(format!("{}.gz", name));
        let brotli_path = path.with_file_name(format!("{}.br", name));
        let mut gzip = GzEncoder::new(Vec::new(), Compression::best());
        gzip.write_all(&data)?;
        fs::write(&gzip_path, gzip.finish()?)?;
        let mut brotli_data = Vec::new();
        {
            let mut brotli = CompressorWriter::new(&mut brotli_data, 4096, 4, 22);
            brotli.write_all(&data)?;
        }
        fs::write(&brotli_path, brotli_data)?;
        let request_path = format!(
            "/{}",
            path.strip_prefix(static_dir)?
                .to_string_lossy()
                .replace('\\', "/")
        );
        let variants = vec![
            compressed_variant("br", &brotli_path)?,
            compressed_variant("gzip", &gzip_path)?,
        ];
        files.insert(
            request_path,
            StaticFile {
                file_path: path.to_path_buf(),
                variants,
            },
        );
    }
    println!("Pre-compressed {} static file(s).", files.len());
    Ok(files)
}

fn compressed_variant(encoding: &'static str, path: &Path) -> Result<CompressedVariant> {
    let metadata = fs::metadata(path)?;
    Ok(CompressedVariant {
        encoding,
        file_path: path.to_path_buf(),
        size: metadata.len(),
        modified: httpdate_like(metadata.modified()?),
        etag: format!(
            "W/\"{}-{}\"",
            metadata.len(),
            metadata
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs()
        ),
    })
}

fn httpdate_like(time: std::time::SystemTime) -> String {
    // Valid enough for static-cache validators; browsers do not require exact server date formatting here.
    match time.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_secs().to_string(),
        Err(_) => "0".to_string(),
    }
}

async fn static_get(State(state): State<AppState>, request: Request<Body>) -> Response<Body> {
    if !host_allowed(&state, &request) {
        return (StatusCode::FORBIDDEN, "Forbidden host").into_response();
    }
    let path = request.uri().path();
    let request_path = if path.ends_with('/') {
        format!("{}index.html", path)
    } else {
        path.to_string()
    };
    if let Some(file) = state.static_files.get(&request_path) {
        let accepted = parse_accept_encoding_header(&request);
        for variant in &file.variants {
            if encoding_accepted(&accepted, variant.encoding) {
                let body = match tokio::fs::read(&variant.file_path).await {
                    Ok(data) => Body::from(data),
                    Err(_) => return StatusCode::NOT_FOUND.into_response(),
                };
                let mut response = Response::new(body);
                response
                    .headers_mut()
                    .insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
                response.headers_mut().insert(
                    header::CONTENT_ENCODING,
                    HeaderValue::from_static(variant.encoding),
                );
                response.headers_mut().insert(
                    header::CONTENT_LENGTH,
                    HeaderValue::from_str(&variant.size.to_string()).unwrap(),
                );
                response.headers_mut().insert(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=0"),
                );
                response.headers_mut().insert(
                    header::LAST_MODIFIED,
                    HeaderValue::from_str(&variant.modified).unwrap(),
                );
                response
                    .headers_mut()
                    .insert(header::ETAG, HeaderValue::from_str(&variant.etag).unwrap());
                let content_type = mime_guess::from_path(&file.file_path)
                    .first_or_octet_stream()
                    .to_string();
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(&content_type).unwrap(),
                );
                return response;
            }
        }
    }
    let target = safe_static_path(&state.static_dir, &request_path);
    match target.and_then(|path| fs::read(&path).ok().map(|data| (path, data))) {
        Some((path, data)) => {
            let mut response = Response::new(Body::from(data));
            let content_type = mime_guess::from_path(path)
                .first_or_octet_stream()
                .to_string();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&content_type).unwrap(),
            );
            response
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn host_allowed(state: &AppState, request: &Request<Body>) -> bool {
    if state.allowed_hosts.is_empty() {
        return true;
    }
    let Some(host) = request
        .headers()
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
    else {
        return false;
    };
    let hostname = host.split(':').next().unwrap_or(host);
    state
        .allowed_hosts
        .iter()
        .any(|allowed| allowed == host || allowed == hostname)
}

fn safe_static_path(root: &Path, request_path: &str) -> Option<PathBuf> {
    let relative = request_path.trim_start_matches('/');
    let full = root.join(relative).canonicalize().ok()?;
    if full.starts_with(root.canonicalize().ok()?) && full.is_file() {
        Some(full)
    } else {
        None
    }
}

fn parse_accept_encoding_header(request: &Request<Body>) -> HashMap<String, f32> {
    let mut accepted = HashMap::new();
    let Some(header_value) = request
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
    else {
        return accepted;
    };
    for entry in header_value.split(',') {
        let normalized = entry.trim().to_lowercase();
        let mut parts = normalized.split(';').map(|part| part.trim().to_string());
        let Some(name) = parts.next() else {
            continue;
        };
        let mut quality = 1.0;
        for parameter in parts {
            if let Some(raw) = parameter.strip_prefix("q=") {
                quality = raw.parse().unwrap_or(0.0);
            }
        }
        accepted.insert(name, quality);
    }
    accepted
}

fn encoding_accepted(accepted: &HashMap<String, f32>, encoding: &str) -> bool {
    accepted
        .get(encoding)
        .copied()
        .or_else(|| accepted.get("*").copied())
        .unwrap_or(0.0)
        > 0.0
}

async fn mcp_method_not_allowed() -> impl IntoResponse {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(
            json!({"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}),
        ),
    )
}

async fn mcp_post(State(state): State<AppState>, Json(body): Json<Value>) -> impl IntoResponse {
    let result = handle_mcp(&state.bundle, &body);
    Json(result)
}

fn tool_result(value: Value) -> Value {
    json!({"content":[{"type":"text","text": serde_json::to_string_pretty(&value).unwrap()}]})
}

fn tool_error(message: impl std::fmt::Display) -> Value {
    json!({"isError":true,"content":[{"type":"text","text": format!("Error: {}", message)}]})
}

fn handle_mcp(bundle: &Bundle, body: &Value) -> Value {
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method == "initialize" {
        return json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"programming-languages-research","version":"0.1.0"}}});
    }
    if method == "tools/list" {
        return json!({"jsonrpc":"2.0","id":id,"result":{"tools": mcp_tools()}});
    }
    if method == "tools/call" {
        let params = body.get("params").unwrap_or(&Value::Null);
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let args = params.get("arguments").unwrap_or(&Value::Null);
        let result = match call_tool(bundle, name, args) {
            Ok(value) => tool_result(value),
            Err(error) => tool_error(error),
        };
        return json!({"jsonrpc":"2.0","id":id,"result":result});
    }
    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})
}

fn mcp_tools() -> Vec<Value> {
    vec![
        json!({"name":"list_records","description":"Enumerate records with optional kind/tag/match filters.","inputSchema":{"type":"object"}}),
        json!({"name":"get_record","description":"Return one record or one section.","inputSchema":{"type":"object"}}),
        json!({"name":"list_tags","description":"List tags and usage counts.","inputSchema":{"type":"object"}}),
        json!({"name":"get_tag","description":"Return tag descriptor and tagged sections.","inputSchema":{"type":"object"}}),
        json!({"name":"list_axes","description":"List tag axes.","inputSchema":{"type":"object"}}),
        json!({"name":"get_axis","description":"Group sections by one tag axis.","inputSchema":{"type":"object"}}),
        json!({"name":"search","description":"Search records and sections.","inputSchema":{"type":"object"}}),
        json!({"name":"get_cross_refs","description":"Return inbound and outbound refs.","inputSchema":{"type":"object"}}),
    ]
}

fn call_tool(bundle: &Bundle, name: &str, args: &Value) -> Result<Value> {
    match name {
        "list_records" => Ok(list_records(bundle, args)),
        "get_record" => get_record(bundle, args),
        "list_tags" => Ok(list_tags(bundle, args)),
        "get_tag" => get_tag(bundle, args),
        "list_axes" => Ok(json!({"axes": bundle.indexes.tag_axes})),
        "get_axis" => get_axis(bundle, args),
        "search" => Ok(search(bundle, args)),
        "get_cross_refs" => get_cross_refs(bundle, args),
        _ => Err(anyhow!("Unknown tool: {}", name)),
    }
}

fn list_records(bundle: &Bundle, args: &Value) -> Value {
    let kind = args.get("kind").and_then(Value::as_str);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
    let match_text = args
        .get("match")
        .and_then(Value::as_str)
        .map(str::to_lowercase);
    let tag_all: Vec<String> = args
        .get("tag")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    let tag_any: Vec<String> = args
        .get("tag_any")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut records = Vec::new();
    for (id, record) in &bundle.records {
        if kind.is_some_and(|kind| format!("{:?}", record.kind).to_lowercase() != kind) {
            continue;
        }
        if !tag_all.is_empty()
            && !tag_all.iter().all(|tag| {
                record
                    .sections
                    .iter()
                    .any(|section| section.tags.contains(tag))
            })
        {
            continue;
        }
        if !tag_any.is_empty()
            && !tag_any.iter().any(|tag| {
                record
                    .sections
                    .iter()
                    .any(|section| section.tags.contains(tag))
            })
        {
            continue;
        }
        if let Some(needle) = &match_text {
            let haystack = format!(
                "{} {} {} {}",
                id,
                record.name,
                record.summary.clone().unwrap_or_default(),
                record.aliases.clone().unwrap_or_default().join(" ")
            )
            .to_lowercase();
            if !haystack.contains(needle) {
                continue;
            }
        }
        records.push(json!({
            "id": id,
            "kind": format!("{:?}", record.kind).to_lowercase(),
            "name": record.name,
            "summary": record.summary.clone().unwrap_or_default(),
            "aliases": record.aliases.clone().unwrap_or_default(),
            "sections": record.sections.iter().map(|section| json!({"id":section.id,"title":section.title,"tags":section.tags})).collect::<Vec<_>>(),
            "tags": record.derived_tags,
        }));
        if records.len() >= limit {
            break;
        }
    }
    json!({"count":records.len(),"truncated":records.len()>=limit,"records":records})
}

fn get_record(bundle: &Bundle, args: &Value) -> Result<Value> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing id"))?;
    let record = bundle
        .records
        .get(id)
        .ok_or_else(|| anyhow!("Unknown record: {}", id))?;
    if let Some(section_id) = args.get("section").and_then(Value::as_str) {
        let section = record
            .sections
            .iter()
            .find(|section| section.id == section_id)
            .ok_or_else(|| anyhow!("Unknown section: {}", section_id))?;
        return Ok(
            json!({"recordId":id,"recordName":record.name,"id":section.id,"title":section.title,"tags":section.tags,"content":section.content,"refs":section.refs,"sources":section.sources,"backlinks":section.backlinks,"mentions":section.mentions}),
        );
    }
    Ok(serde_json::to_value(record)?)
}

fn list_tags(bundle: &Bundle, args: &Value) -> Value {
    let axis = args.get("axis").and_then(Value::as_str);
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for record in bundle.records.values() {
        for section in &record.sections {
            for tag in &section.tags {
                *counts.entry(tag.clone()).or_default() += 1;
            }
        }
    }
    let tags: Vec<Value> = bundle.indexes.tags.iter().filter(|tag| axis.is_none_or(|axis| tag_axis(tag).as_deref() == Some(axis))).map(|tag| json!({"tag":tag,"axis":tag_axis(tag),"count":counts.get(tag).copied().unwrap_or(0),"descriptor":bundle.tag_descriptors.get(tag)})).collect();
    json!({"count":tags.len(),"tags":tags})
}

fn sections_with_tag(bundle: &Bundle, tag: &str) -> Vec<Value> {
    let mut sections = Vec::new();
    for (record_id, record) in &bundle.records {
        for section in &record.sections {
            if section.tags.iter().any(|section_tag| section_tag == tag) {
                sections.push(json!({"recordId":record_id,"recordName":record.name,"sectionId":section.id,"sectionTitle":section.title,"tags":section.tags}));
            }
        }
    }
    sections
}

fn get_tag(bundle: &Bundle, args: &Value) -> Result<Value> {
    let tag = args
        .get("tag")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing tag"))?;
    let sections = sections_with_tag(bundle, tag);
    Ok(
        json!({"tag":tag,"descriptor":bundle.tag_descriptors.get(tag),"count":sections.len(),"sections":sections}),
    )
}

fn get_axis(bundle: &Bundle, args: &Value) -> Result<Value> {
    let axis = args
        .get("axis")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing axis"))?;
    let tags = bundle
        .indexes
        .tag_axes
        .get(axis)
        .ok_or_else(|| anyhow!("No tags registered under axis: {}", axis))?;
    Ok(
        json!({"axis":axis,"groups":tags.iter().map(|tag| { let sections = sections_with_tag(bundle, tag); json!({"tag":tag,"descriptor":bundle.tag_descriptors.get(tag),"count":sections.len(),"sections":sections}) }).collect::<Vec<_>>() }),
    )
}

fn search(bundle: &Bundle, args: &Value) -> Value {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let scope = args.get("scope").and_then(Value::as_str).unwrap_or("both");
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
    let mut results = Vec::new();
    for (record_id, record) in &bundle.records {
        if scope == "record" || scope == "both" {
            let haystack = format!(
                "{} {} {}",
                record_id,
                record.name,
                record.summary.clone().unwrap_or_default()
            )
            .to_lowercase();
            if haystack.contains(&query) {
                results.push(json!({"type":"record","recordId":record_id,"kind":format!("{:?}", record.kind).to_lowercase(),"name":record.name,"summary":record.summary.clone().unwrap_or_default()}));
            }
        }
        if scope == "section" || scope == "both" {
            for section in &record.sections {
                let haystack = format!(
                    "{} {} {} {}",
                    section.id,
                    section.title,
                    section.tags.join(" "),
                    section.content
                )
                .to_lowercase();
                if haystack.contains(&query) {
                    results.push(json!({"type":"section","recordId":record_id,"recordName":record.name,"sectionId":section.id,"sectionTitle":section.title,"tags":section.tags}));
                }
                if results.len() >= limit {
                    break;
                }
            }
        }
        if results.len() >= limit {
            break;
        }
    }
    json!({"query":query,"scope":scope,"count":results.len(),"truncated":results.len()>=limit,"results":results})
}

fn get_cross_refs(bundle: &Bundle, args: &Value) -> Result<Value> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing id"))?;
    let section_filter = args.get("section").and_then(Value::as_str);
    let record = bundle
        .records
        .get(id)
        .ok_or_else(|| anyhow!("Unknown record: {}", id))?;
    let mut outbound = Vec::new();
    let mut inbound = Vec::new();
    for section in &record.sections {
        if section_filter.is_some_and(|filter| filter != section.id) {
            continue;
        }
        for reference in &section.refs {
            outbound.push(json!({"from":{"recordId":id,"sectionId":section.id},"target":reference.target,"type":reference.reference_type}));
        }
        for backlink in &section.backlinks {
            inbound.push(json!({"to":{"recordId":id,"sectionId":section.id},"source":backlink.source,"type":backlink.reference_type}));
        }
    }
    Ok(json!({"recordId":id,"sectionId":section_filter,"outbound":outbound,"inbound":inbound}))
}
