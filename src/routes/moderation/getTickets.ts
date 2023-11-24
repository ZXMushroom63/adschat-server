import { Request, Response, Router } from 'express';
import { prisma } from '../../common/database';
import { authenticate } from '../../middleware/authenticate';
import { isModMiddleware } from './isModMiddleware';
export function getTickets(Router: Router) {
  Router.get('/moderation/tickets', authenticate(), isModMiddleware, route);
}

async function route(req: Request, res: Response) {
  const after = req.query.after
    ? parseInt(req.query.after as string)
    : undefined;
  let limit = parseInt((req.query.limit || '30') as string);

  if (limit > 30) {
    limit = 30;
  }

  const tickets = await prisma.ticket.findMany({
    orderBy: {
      lastUpdatedAt: 'desc',
    },
    ...(after ? { skip: 1 } : undefined),
    take: limit,
    ...(after ? { cursor: { id: after } } : undefined),
    select: {
      id: true,
      status: true,
      category: true,
      title: true,
      openedAt: true,
      channelId: true,
      lastUpdatedAt: true,
    },
  });

  res.json(tickets);
}
