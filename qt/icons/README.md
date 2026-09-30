Source files used to produce some of the svg/png files.

`learnrecur.svg` is the source for LearnRecur's blue seahorse icon. On Mac, regenerate the committed Qt PNG and installer ICNS with:

```sh
QT_QPA_PLATFORM=offscreen out/pyenv/bin/python qt/tools/build_learnrecur_icon.py
```

The ICNS includes the standard 16–512 point sizes at both resolutions. Keep the SVG, PNG, and ICNS together when changing the icon.
