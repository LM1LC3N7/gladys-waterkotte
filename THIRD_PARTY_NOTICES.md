# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## ha-waterkotte

<https://github.com/marq24/ha-waterkotte> (the Home Assistant integration
for Waterkotte heat pumps, with its library `pywaterkotte_ha`), by Matthias
Marquardt and contributors. MIT License (`LICENSE` of the repository, version
2026.10.7, commit `311382f`). Its notice:

```
MIT License

Copyright (c) 2023 Matthias Marquardt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

What was ported: the requests of the EcoTouch web interface (`/cgi/login`,
`/cgi/readTags`, `/cgi/writeTags`, `/cgi/logout`) and the format of their
answers, the EasyCon XML request (`/config/xml.cgi`), the tag numbers and
their scale (analog tags in tenths), the meaning of the operation tags
(I30, I32: 0 off, 1 auto, 2 manual) and of the status bits (I51), the serial
number tags (I114, I115) and the range of the hot water setpoint (28 to
70 °C, capped here at 60 °C). Changed: one session kept and logged in again
at most once per poll or command (never in a loop), "too many users" as a
pause, a refused password kept and never sent again by itself, a read back
before any success, bounded answers, and EasyCon read only.
