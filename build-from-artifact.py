# Rebuilds index.html from the artifact source (ckm-multiservices.html).
import sys, pathlib
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '../ckm-multiservices.html').read_text()
split = src.index('<a class="skip"')
head, body = src[:split], src[split:]
body = body.replace('<form id="estimateForm" novalidate data-endpoint="">', '<form id="estimateForm" novalidate data-endpoint="/api/estimate">', 1)
assert 'data-endpoint="/api/estimate"' in body
out = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
       + head + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n')
pathlib.Path(__file__).with_name('index.html').write_text(out)
print('index.html written', len(out), 'bytes')
