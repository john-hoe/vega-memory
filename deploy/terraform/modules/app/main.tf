locals {
  base_name      = lower(replace("${var.project_name}-${var.environment}", "_", "-"))
  short_name     = substr(local.base_name, 0, 20)
  container_name = "vega-memory"
  container_port = 3000
}

data "aws_iam_policy_document" "task_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_ecr_repository" "this" {
  name                 = "${local.base_name}/vega-memory"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.tags, {
    Name = "${local.base_name}-ecr"
  })
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.base_name}"
  retention_in_days = 30

  tags = merge(var.tags, {
    Name = "${local.base_name}-logs"
  })
}

resource "aws_iam_role" "execution" {
  name               = "${local.short_name}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.task_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.base_name}-ecs-exec"
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${local.short_name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume_role.json

  tags = merge(var.tags, {
    Name = "${local.base_name}-ecs-task"
  })
}

resource "aws_security_group" "alb" {
  name        = "${local.short_name}-alb-sg"
  description = "Security group for the public ALB"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP from the internet"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${local.base_name}-alb-sg"
  })
}

resource "aws_security_group" "service" {
  name        = "${local.short_name}-svc-sg"
  description = "Security group for ECS tasks"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Application traffic from the ALB"
    from_port       = local.container_port
    to_port         = local.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${local.base_name}-svc-sg"
  })
}

resource "aws_lb" "this" {
  name               = "${local.short_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  tags = merge(var.tags, {
    DomainName = var.domain_name
    Name       = "${local.base_name}-alb"
  })
}

resource "aws_lb_target_group" "this" {
  name        = "${local.short_name}-tg"
  port        = local.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    matcher             = "200,401"
    path                = "/api/health"
    protocol            = "HTTP"
    timeout             = 5
  }

  tags = merge(var.tags, {
    Name = "${local.base_name}-tg"
  })
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }

  # TODO: Replace placeholder values with an ACM certificate and Route 53 records before enabling HTTPS for var.domain_name.
}

resource "aws_ecs_cluster" "this" {
  name = "${local.base_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(var.tags, {
    Name = "${local.base_name}-cluster"
  })
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${local.base_name}-task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  # TODO: Replace placeholder values for VEGA_API_KEY, database credentials, and OLLAMA_BASE_URL with account-specific secrets and service endpoints.
  container_definitions = jsonencode([
    {
      name      = local.container_name
      image     = "${aws_ecr_repository.this.repository_url}:latest"
      essential = true
      command   = ["node", "dist/scheduler/index.js"]
      portMappings = [
        {
          containerPort = local.container_port
          hostPort      = local.container_port
          protocol      = "tcp"
        }
      ]
      environment = [
        {
          name  = "VEGA_API_PORT"
          value = tostring(local.container_port)
        },
        {
          name  = "VEGA_API_KEY"
          value = "TODO_REPLACE_ME"
        },
        {
          name  = "VEGA_PG_HOST"
          value = var.rds_host
        },
        {
          name  = "VEGA_PG_PORT"
          value = "5432"
        },
        {
          name  = "VEGA_PG_DATABASE"
          value = "vega"
        },
        {
          name  = "VEGA_PG_USER"
          value = "vega_admin"
        },
        {
          name  = "VEGA_PG_PASSWORD"
          value = "TODO_REPLACE_ME"
        },
        {
          name  = "VEGA_PG_SSL"
          value = "true"
        },
        {
          name  = "VEGA_REDIS_ENABLED"
          value = "true"
        },
        {
          name  = "VEGA_REDIS_HOST"
          value = var.redis_endpoint
        },
        {
          name  = "VEGA_REDIS_PORT"
          value = "6379"
        },
        {
          name  = "OLLAMA_BASE_URL"
          value = "http://replace-me.internal:11434"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "this" {
  name                               = "${local.base_name}-service"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.app_replicas
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 60
  enable_execute_command             = true

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = local.container_name
    container_port   = local.container_port
  }

  depends_on = [aws_lb_listener.http]

  tags = merge(var.tags, {
    Name = "${local.base_name}-service"
  })
}
