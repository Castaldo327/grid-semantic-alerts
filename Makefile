PY := .venv/bin/python

.PHONY: all setup web preview check clean-derived

all:            ## regenerate everything (reuses cached Grid Status pulls and gpt-6-luna responses)
	$(PY) -m pipeline.run
	cd web && node scripts/save_runs.ts

setup:
	uv venv -p 3.12 .venv && uv pip install -p $(PY) -e .
	cd web && npm install

web:
	cd web && npm run build

preview: web
	cd web && npx vite preview

check:          ## rule parity (Python vs TypeScript) and a secret scan of the build
	cd web && npm run check-rules
	! grep -rIlE -e "api\.gridstatus\.io" -e "sk-[A-Za-z0-9_-]{20,}" web/dist web/public pipeline README.md FINDINGS.md

clean-derived:  ## drop derived outputs (keeps raw pulls and the model cache)
	rm -rf data/state data/alerts data/decisions web/public/demo web/public/explore
