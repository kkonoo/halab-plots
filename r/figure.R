# HaLab Plots — R side. Runs inside webR in the browser; js/r-engine.js calls these functions.
# A figure file is a saveRDS() of a ggplot / patchwork / pheatmap / grid grob,
# or of list(plot = <one of those>, table = <data frame or matrix>) to attach a data table.

fb <- new.env()   # figures loaded so far: fb$figs[[id]] = list(plot, table, kind, built)
fb$figs <- list()
fb_get <- function(id) fb$figs[[id]] %||% stop("This figure isn't loaded yet.")

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

fb_load <- function(path, id) {
  f <- fb_unwrap(fb_read(path))
  if (f$kind == "ggplot") f$built <- ggplot2::ggplot_build(f$plot)
  fb$figs[[id]] <- f
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
    info$style <- fb_style(f$plot, f$built)
  }
  if (f$kind == "pheatmap") {
    pal <- fb_heat_palette(f$plot)
    if (length(pal)) info$heat <- lapply(list(low = 1, mid = ceiling(length(pal) / 2), high = length(pal)), function(i) fb_hex(pal[i]))
  }
  jsonlite::toJSON(info, auto_unbox = TRUE)
}

# ---------- style ----------
# What can be changed per kind of layer: name on the page, settings. A layer takes the first of its geom's classes found here.
FB_GEOMS <- list(
  GeomPoint      = list("Points", c("size", "alpha", "colour")),
  GeomBar        = list("Bars", c("width", "alpha", "fill")),          # also geom_col, geom_histogram
  GeomBoxplot    = list("Boxes", c("width", "alpha", "fill")),
  GeomViolin     = list("Violins", c("width", "alpha", "fill")),
  GeomErrorbar   = list("Error bars", c("width", "linewidth", "colour")),
  GeomTextRepel  = list("Text labels", c("size_pt", "colour")),
  GeomLabelRepel = list("Text labels", c("size_pt", "colour")),
  GeomText       = list("Text labels", c("size_pt", "colour")),
  GeomLabel      = list("Text labels", c("size_pt", "colour")),
  GeomSmooth     = list("Trend line", c("linewidth", "colour")),
  GeomVline      = list("Reference line", c("linewidth", "colour")),
  GeomHline      = list("Reference line", c("linewidth", "colour")),
  GeomAbline     = list("Reference line", c("linewidth", "colour")),
  GeomPath       = list("Lines", c("linewidth", "alpha", "colour")),   # also geom_line, geom_step
  GeomRibbon     = list("Areas", c("alpha", "fill"))                   # also geom_area, geom_density
)

fb_hex <- function(x) {
  x <- x[!is.na(x)]
  if (!length(x)) return("#999999")
  m <- grDevices::col2rgb(x[1])
  grDevices::rgb(m[1], m[2], m[3], maxColorValue = 255)
}

# Current values, read from the built plot. A setting that varies with the data is left out
# (colour/fill mapped to a variable are changed through its scale instead).
fb_style <- function(p, b) {
  layers <- list()
  for (i in seq_along(p$layers)) {
    l <- p$layers[[i]]
    hit <- intersect(class(l$geom), names(FB_GEOMS))
    if (!length(hit)) next
    g <- FB_GEOMS[[hit[1]]]
    params <- list()
    for (k in g[[2]]) {
      if (k == "width") {
        params$width <- l$geom_params$width %||% l$aes_params$width %||% l$stat_params$width %||% 0.9
        next
      }
      v <- unique(b$data[[i]][[if (k == "size_pt") "size" else k]])
      if (length(v) != 1) next
      params[[k]] <- switch(k, colour = , fill = fb_hex(v), alpha = if (is.na(v)) 1 else v,
                            size_pt = round(v * ggplot2::.pt, 1), v)
    }
    if (length(params)) layers[[length(layers) + 1]] <- list(i = i, name = g[[1]], params = params)
  }
  scales <- list()
  for (a in c("colour", "fill")) {
    s <- b$plot$scales$get_scales(a)
    if (is.null(s) || inherits(s, c("ScaleDiscreteIdentity", "ScaleContinuousIdentity", "ScaleBinned"))) next
    name <- ggplot2::get_labs(p)[[a]]
    name <- if (is.character(name) && length(name) == 1) name else a
    if (s$is_discrete()) {
      lv <- s$get_limits()
      if (!length(lv) || length(lv) > 40) next
      scales[[a]] <- list(type = "discrete", name = name, levels = as.list(as.character(lv)), colors = lapply(s$map(lv), fb_hex))
    } else {
      lim <- s$get_limits()
      if (length(lim) != 2 || any(!is.finite(lim))) next
      scales[[a]] <- list(type = "continuous", name = name, limits = lim,
                          low = fb_hex(s$map(lim[1])), mid = fb_hex(s$map(mean(lim))), high = fb_hex(s$map(lim[2])))
    }
  }
  list(layers = layers, scales = scales)
}

fb_layer <- function(p, i, v) {
  # A full copy, so the figure as loaded stays unchanged. (Not ggproto(NULL, layer): after a layer has been
  # drawn once, building such a child overflows the stack in ggplot2 4.0.)
  l <- unserialize(serialize(p$layers[[i]], NULL))
  if (!is.null(v$size_pt)) {
    v$size <- v$size_pt / ggplot2::.pt
    v$size_pt <- NULL
  }
  if (!is.null(v$width)) {
    l$geom_params$width <- v$width
    if ("width" %in% l$stat$parameters()) l$stat_params$width <- v$width   # geom_bar, geom_boxplot work it out in the stat
    if (!is.null(l$aes_params$width)) l$aes_params$width <- v$width
    v$width <- NULL
  }
  if (length(v)) l$aes_params <- utils::modifyList(l$aes_params, v)
  p$layers[[i]] <- l
  p
}

# v: list(type = "discrete", values = list(level = colour)) or list(type = "continuous", n = 2|3, low, mid, high, midpoint)
fb_scale <- function(p, a, v, built) {
  old <- built$plot$scales$get_scales(a)
  keep <- list(name = old$name, breaks = old$breaks, labels = old$labels, guide = old$guide, na.value = old$na.value, limits = old$limits)
  pick <- function(stem) getExportedValue("ggplot2", paste0("scale_", a, "_", stem))
  sc <- if (v$type == "discrete") do.call(pick("manual"), c(list(values = unlist(v$values)), keep)) else
    if (identical(as.numeric(v$n), 2)) do.call(pick("gradient"), c(list(low = v$low, high = v$high, oob = old$oob), keep)) else
    do.call(pick("gradient2"), c(list(low = v$low, mid = v$mid, high = v$high, midpoint = v$midpoint %||% 0, oob = old$oob), keep))
  suppressMessages(p + sc)
}

# pheatmap draws fixed colours. Every cell's colour is one of the legend's colours, so recolouring the
# legend palette (same breaks) and swapping each cell's colour by its place in it gives the new heatmap.
fb_heat_palette <- function(g) {
  li <- which(g$layout$name == "legend")
  if (!length(li)) return(NULL)
  r <- Filter(function(x) inherits(x, "rect"), g$grobs[[li]]$children)
  if (length(r)) r[[1]]$gp$fill
}

fb_heat <- function(g, h) {
  old <- fb_heat_palette(g)
  if (is.null(old)) return(g)
  cols <- unlist(if (identical(as.numeric(h$n), 2)) h[c("low", "high")] else h[c("low", "mid", "high")])
  new <- grDevices::colorRampPalette(cols)(length(old))
  recolour <- function(x) {
    if (!inherits(x, "rect")) return(x)
    f <- x$gp$fill
    idx <- match(f, old)
    f[!is.na(idx)] <- new[idx[!is.na(idx)]]   # NA cells (na_col) are not in the palette and stay as they were
    x$gp$fill <- f
    x
  }
  for (nm in c("legend", "matrix")) {
    j <- which(g$layout$name == nm)
    if (length(j)) g$grobs[[j]]$children <- do.call(grid::gList, lapply(g$grobs[[j]]$children, recolour))
  }
  g
}

# f: a loaded figure (fb_get). e: list(labels = list(x = "...", ...), size = <base font size in pt>,
#   layers = list("<i>" = list(size = .., ...)), scales = list(colour = .., fill = ..), heat = list(n, low, mid, high)).
# "" removes a label.
fb_edit <- function(f, e) {
  p <- f$plot
  if (f$kind == "pheatmap") return(if (is.null(e$heat)) p else fb_heat(p, e$heat))
  if (f$kind == "ggplot") {
    # settings are kept per figure in the browser; after the file is re-saved a layer or scale may be gone
    for (i in names(e$layers)) if (as.integer(i) <= length(p$layers)) p <- fb_layer(p, as.integer(i), e$layers[[i]])
    for (a in names(e$scales)) if (!is.null(f$built$plot$scales$get_scales(a))) p <- fb_scale(p, a, e$scales[[a]], f$built)
  }
  if (length(e$labels)) p <- p + do.call(ggplot2::labs, lapply(e$labels, function(v) if (identical(v, "")) NULL else v))
  if (!is.null(e$size)) {
    th <- ggplot2::theme(text = ggplot2::element_text(size = e$size))
    p <- if (f$kind == "patchwork") p & th else p + th
  }
  p
}

# Draws into the current grid viewport (a whole page, or one panel of a combined figure)
fb_draw <- function(f, e) {
  p <- fb_edit(f, e)
  set.seed(1)   # ggrepel places labels at random; a fixed seed keeps the preview and the file alike
  if (f$kind %in% c("ggplot", "patchwork")) print(p, newpage = FALSE) else grid::grid.draw(p)
}

# w, h in inches; dpi only matters for raster formats
fb_device <- function(path, fmt, w, h, dpi) {
  switch(fmt,
    png  = ragg::agg_png(path, w, h, units = "in", res = dpi),
    jpeg = ragg::agg_jpeg(path, w, h, units = "in", res = dpi, quality = 95),
    tiff = ragg::agg_tiff(path, w, h, units = "in", res = dpi, compression = "lzw"),
    pdf  = grDevices::cairo_pdf(path, w, h),
    svg  = svglite::svglite(path, w, h),
    stop("Unknown format: ", fmt))
  grid::grid.newpage()
}

fb_save <- function(path, fmt, w, h, dpi, edits, id) {
  f <- fb_get(id)
  fb_device(path, fmt, w, h, dpi)
  on.exit(grDevices::dev.off())
  fb_draw(f, jsonlite::fromJSON(edits, simplifyVector = FALSE))
  invisible()
}

# A combined figure. spec: list(panels = list(list(id, x, y, w, h (inches from the top left), edits, letter)),
#                              letters = list(size = <pt>, bold = TRUE/FALSE))
fb_page <- function(path, fmt, w, h, dpi, spec) {
  s <- jsonlite::fromJSON(spec, simplifyVector = FALSE)
  fb_device(path, fmt, w, h, dpi)
  on.exit(grDevices::dev.off())
  u <- function(v) grid::unit(v, "in")
  for (pn in s$panels) {
    grid::pushViewport(grid::viewport(x = u(pn$x), y = u(h - pn$y), width = u(pn$w), height = u(pn$h), just = c("left", "top")))
    fb_draw(fb_get(pn$id), pn$edits)
    grid::popViewport()
  }
  for (pn in s$panels) if (nzchar(pn$letter %||% ""))   # letters last, so no panel covers them
    grid::grid.text(pn$letter, x = u(pn$x), y = u(h - pn$y), just = c("left", "top"),
                    gp = grid::gpar(fontsize = s$letters$size, fontface = if (isTRUE(s$letters$bold)) "bold" else "plain"))
  invisible()
}

fb_table <- function(path, fmt, id) {
  t <- fb_get(id)$table
  t[] <- lapply(t, function(col) if (is.list(col)) vapply(col, function(v) paste(format(v), collapse = ";"), "") else col)
  rn <- is.character(attr(t, "row.names"))   # gene names etc.; plain row numbers are dropped
  out <- utils::capture.output(if (fmt == "csv") utils::write.csv(t, row.names = rn) else
    utils::write.table(t, sep = "\t", quote = FALSE, row.names = rn, col.names = if (rn) NA else TRUE))
  writeLines(out, path, useBytes = TRUE)
}
