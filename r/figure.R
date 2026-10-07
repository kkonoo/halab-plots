# HaLab Plots — R side. Runs inside webR in the browser; js/r-engine.js calls these functions.
# A figure file is a saveRDS() of a ggplot / patchwork / pheatmap / grid grob,
# or of list(plot = <one of those>, table = <data frame or matrix>) to attach a data table.

fb <- new.env()   # the figure on screen: fb$plot, fb$table, fb$kind

# Drawing a gtable (pheatmap's figure) needs gtable's methods, and readRDS alone doesn't load the package
loadNamespace("gtable")

# readRDS, installing any package the object refers to that webR doesn't have yet (e.g. cowplot)
fb_read <- function(path) {
  miss <- character()
  obj <- withCallingHandlers(readRDS(path), warning = function(w) {
    m <- regmatches(conditionMessage(w), regexec("namespace .([A-Za-z0-9.]+). is not available", conditionMessage(w)))[[1]]
    if (length(m) == 2) {
      miss <<- c(miss, m[2])
      invokeRestart("muffleWarning")
    }
  })
  if (length(miss)) {
    try(webr::install(unique(miss), quiet = TRUE), silent = TRUE)
    obj <- suppressWarnings(readRDS(path))
  }
  obj
}

fb_unwrap <- function(x) {
  table <- NULL
  if (is.list(x) && !inherits(x, c("gg", "grob", "pheatmap")) && !is.null(x$plot)) {
    table <- x$table
    x <- x$plot
  }
  kind <- if (inherits(x, "pheatmap")) "pheatmap" else if (inherits(x, "patchwork")) "patchwork" else
    if (inherits(x, "ggplot")) "ggplot" else if (inherits(x, "grob")) "grob" else
    stop("Not a ggplot, patchwork, pheatmap or grid grob object.")
  if (kind == "pheatmap") x <- x$gtable
  # a ggplot carries its own data; pheatmap and patchwork need list(plot =, table =)
  if (is.null(table) && kind == "ggplot" && is.data.frame(x$data)) table <- x$data
  if (!is.null(table)) table <- as.data.frame(table)
  if (!is.null(table) && !nrow(table)) table <- NULL
  list(plot = x, table = table, kind = kind)
}

fb_load <- function(path) {
  f <- fb_unwrap(fb_read(path))
  list2env(f, fb)
  info <- list(kind = f$kind, rows = 0L, cols = 0L)
  if (!is.null(f$table)) info[c("rows", "cols")] <- dim(f$table)
  if (f$kind %in% c("ggplot", "patchwork")) {
    size <- tryCatch(ggplot2::calc_element("text", ggplot2::complete_theme(f$plot$theme))$size, error = function(e) NULL)
    if (is.numeric(size)) info$size <- size
  }
  if (f$kind == "ggplot") {
    keys <- c("title", "subtitle", "caption", "x", "y", "colour", "fill", "shape", "size", "linetype", "alpha")
    labs <- ggplot2::get_labs(f$plot)[keys]
    names(labs) <- keys
    # only plain text labels are editable; expression labels (plotmath) are left as they are
    info$labels <- Filter(function(v) is.character(v) && length(v) == 1, labs)
  }
  jsonlite::toJSON(info, auto_unbox = TRUE)
}

# edits: list(labels = list(x = "...", ...), size = <base font size in pt>). "" removes a label.
fb_edit <- function(e) {
  p <- fb$plot
  if (length(e$labels)) p <- p + do.call(ggplot2::labs, lapply(e$labels, function(v) if (identical(v, "")) NULL else v))
  if (!is.null(e$size)) {
    th <- ggplot2::theme(text = ggplot2::element_text(size = e$size))
    p <- if (fb$kind == "patchwork") p & th else p + th
  }
  p
}

# w, h in inches; dpi only matters for raster formats
fb_save <- function(path, fmt, w, h, dpi, edits) {
  p <- fb_edit(jsonlite::fromJSON(edits, simplifyVector = FALSE))
  switch(fmt,
    png  = ragg::agg_png(path, w, h, units = "in", res = dpi),
    jpeg = ragg::agg_jpeg(path, w, h, units = "in", res = dpi, quality = 95),
    tiff = ragg::agg_tiff(path, w, h, units = "in", res = dpi, compression = "lzw"),
    pdf  = grDevices::cairo_pdf(path, w, h),
    svg  = svglite::svglite(path, w, h),
    stop("Unknown format: ", fmt))
  on.exit(grDevices::dev.off())
  set.seed(1)   # ggrepel places labels at random; a fixed seed keeps the preview and the file alike
  if (fb$kind %in% c("ggplot", "patchwork")) print(p) else {
    grid::grid.newpage()
    grid::grid.draw(p)
  }
  invisible()
}

fb_table <- function(path, fmt) {
  t <- fb$table
  t[] <- lapply(t, function(col) if (is.list(col)) vapply(col, function(v) paste(format(v), collapse = ";"), "") else col)
  rn <- is.character(attr(t, "row.names"))   # gene names etc.; plain row numbers are dropped
  out <- utils::capture.output(if (fmt == "csv") utils::write.csv(t, row.names = rn) else
    utils::write.table(t, sep = "\t", quote = FALSE, row.names = rn, col.names = if (rn) NA else TRUE))
  writeLines(out, path, useBytes = TRUE)
}
