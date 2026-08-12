# Orchestrate Driving analysis with Cloudflare Workflows

**Status:** accepted

Video validation and Driving analysis are asynchronous, resumable jobs. Completing an upload starts a Cloudflare Workflow that validates the private R2 object, and creating an analysis immediately returns its identifier while another Workflow durably coordinates Race-window preparation, Subject-car tracking, gate-crossing measurement, and Corner-clip rendering. Each expensive or independently retryable operation is a separate idempotent Workflow step, with CPU-heavy video and vision work delegated to a container; this adds explicit lifecycle and artifact contracts but prevents HTTP timeouts and allows failures or User Re-identification to resume without restarting the entire analysis.
