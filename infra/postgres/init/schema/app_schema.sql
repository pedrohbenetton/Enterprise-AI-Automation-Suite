-- Schema do banco de negócio "automation".
-- Fica em subdiretório para NÃO ser executado automaticamente contra o banco do n8n;
-- é aplicado por 01-init-app-db.sh no banco correto.

BEGIN;

-- ---------------------------------------------------------------------
-- Fluxo A — Triagem de inbound leads / tickets
-- ---------------------------------------------------------------------
CREATE TABLE leads_triage (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key     text        NOT NULL UNIQUE,          -- sha256(email|assunto|corpo)
    received_at         timestamptz NOT NULL DEFAULT now(),
    source              text        NOT NULL,                 -- form, email, chat, api...
    kind                text        NOT NULL CHECK (kind IN ('lead', 'ticket')),
    contact_email       text        NOT NULL,
    contact_name        text,
    company_domain      text,
    subject             text,
    payload             jsonb       NOT NULL,                 -- request original
    enrichment          jsonb,                                -- dados de empresa/contato
    sentiment           text        CHECK (sentiment IN ('positive', 'neutral', 'negative')),
    urgency_score       numeric(3,2) CHECK (urgency_score BETWEEN 0 AND 1),
    priority            text        CHECK (priority IN ('P1', 'P2', 'P3', 'P4')),
    category            text,
    summary             text,
    suggested_reply     text,
    classifier          text        NOT NULL CHECK (classifier IN ('llm_primary', 'llm_fallback', 'rules')),
    hubspot_contact_id  text,
    hubspot_object_id   text,                                 -- ticket ou deal
    slack_message_ts    text,
    status              text        NOT NULL DEFAULT 'processed'
                                    CHECK (status IN ('processed', 'partial', 'failed')),
    processing_ms       integer
);
CREATE INDEX idx_leads_triage_received ON leads_triage (received_at DESC);
CREATE INDEX idx_leads_triage_priority ON leads_triage (priority, received_at DESC);

-- ---------------------------------------------------------------------
-- Fluxo B — Faturas extraídas e validadas
-- ---------------------------------------------------------------------
CREATE TABLE invoices (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_sha256         char(64)    NOT NULL UNIQUE,          -- dedupe do arquivo
    source_filename     text,
    mime_type           text        NOT NULL,
    supplier_name       text        NOT NULL,
    supplier_tax_id     text        NOT NULL,                 -- CNPJ/CPF/VAT normalizado (só dígitos)
    customer_name       text,
    customer_tax_id     text,
    invoice_number      text        NOT NULL,
    issue_date          date        NOT NULL,
    due_date            date,
    currency            char(3)     NOT NULL DEFAULT 'BRL',
    subtotal            numeric(14,2),
    tax_total           numeric(14,2),
    total               numeric(14,2) NOT NULL CHECK (total >= 0),
    line_items          jsonb       NOT NULL DEFAULT '[]'::jsonb,
    extractor           text        NOT NULL CHECK (extractor IN ('llm_primary', 'llm_fallback', 'pdf_text_llm')),
    confidence          numeric(3,2) CHECK (confidence BETWEEN 0 AND 1),
    raw_extraction      jsonb       NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (supplier_tax_id, invoice_number)                  -- dedupe de negócio
);
CREATE INDEX idx_invoices_issue_date ON invoices (issue_date DESC);
CREATE INDEX idx_invoices_supplier   ON invoices (supplier_tax_id);

-- Documentos que falharam na validação de schema/regras: revisão humana
CREATE TABLE invoice_quarantine (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_sha256         char(64)    NOT NULL,
    source_filename     text,
    mime_type           text,
    reason              text        NOT NULL,                 -- schema_invalid, llm_unavailable, business_rule...
    validation_errors   jsonb       NOT NULL DEFAULT '[]'::jsonb,
    raw_extraction      jsonb,
    status              text        NOT NULL DEFAULT 'pending_review'
                                    CHECK (status IN ('pending_review', 'approved', 'rejected')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    reviewed_at         timestamptz
);
CREATE INDEX idx_quarantine_pending ON invoice_quarantine (created_at) WHERE status = 'pending_review';

-- ---------------------------------------------------------------------
-- Dead Letter Queue — alimentada pelo Error Workflow global
-- ---------------------------------------------------------------------
CREATE TABLE workflow_errors (
    id                  bigserial PRIMARY KEY,
    workflow_id         text,
    workflow_name       text        NOT NULL,
    execution_id        text,
    execution_url       text,
    failed_node         text,
    error_message       text        NOT NULL,
    error_stack         text,
    payload             jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz
);
CREATE INDEX idx_workflow_errors_open ON workflow_errors (created_at DESC) WHERE resolved_at IS NULL;

COMMIT;
