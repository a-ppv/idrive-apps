# Changelog

## Unreleased

## 0.8.1

Effect layers and mesh parts choose how they blend (presets such as
`premultiplied`, `max` and `subtract`, or their own factors and
operations) and which colour channels they write, and a part its depth
test. Assets can be sampled with mipmaps (the service makes the levels of
`rgba8` and `r8` assets; a compressed one brings its own), mirrored, with
each axis wrapped its own way and anisotropically. A shader is at most
64 KB.
An app that draws the cluster with layers only, such as a cluster theme,
can show another app's picture (Waze's map) inside it with no scene file:
`host` with `into`. The picture is drawn under the app's layers, and goes
back to its own place when the app hides its layers, ends the host
(`unhost`) or exits.

## 0.8.0

A layer can ask for upload bandwidth while it is shown (`others_fps`): the
other apps' videos are then written at most that many times a second, 15
at the least, until the layer is hidden or goes or its app exits. The apps
held are told (`fps_cap`).

## 0.7.0

A layer can ask for its target's scene to stay loaded on the cluster while
nothing shows it, so the target appears without loading again when a layer
wants it (`preload`).

