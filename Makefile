.PHONY: help up down restart rebuild rebuild-ui logs ps

help:
	@echo "make up          Start everything (builds images if missing)"
	@echo "make down        Stop and remove the containers"
	@echo "make restart     Restart the running containers without rebuilding"
	@echo "make rebuild     Rebuild images and recreate the containers"
	@echo "make rebuild-ui  Rebuild and recreate only the web UI (fast)"
	@echo "make logs        Follow logs from all services"
	@echo "make ps          Show container status"

up:
	docker compose up -d

down:
	docker compose down

restart:
	docker compose restart

rebuild:
	docker compose up -d --build

rebuild-ui:
	docker compose up -d --build ollama-ui

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps
