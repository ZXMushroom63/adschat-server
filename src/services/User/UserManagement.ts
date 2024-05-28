import { dateToDateTime, prisma } from '../../common/database';
import { generateError } from '../../common/errorHandler';
import { sendConfirmCodeMail, sendResetPasswordMail } from '../../common/mailer';
import { generateEmailConfirmCode, generateSecureCode, generateTag } from '../../common/random';
import { removeUserCacheByUserIds } from '../../cache/UserCache';
import { getIO } from '../../socket/socket';
import { AUTHENTICATE_ERROR } from '../../common/ClientEventNames';
import bcrypt from 'bcrypt';
import { generateToken } from '../../common/JWT';
import env from '../../common/env';

export async function sendEmailConfirmCode(userId: string) {
  const account = await getAccountByUserId(userId);

  if (!account) {
    return [null, generateError('Invalid userId.')] as const;
  }

  if (account.emailConfirmed) {
    return [null, generateError('Email already verified.')] as const;
  }

  const code = await updateAccountConfirmCode(userId);

  if (env.DEV_MODE) {
    return [{ message: `DEV MODE: Email verify code: ${code}` }, null] as const;
  }

  sendConfirmCodeMail(code, account.email);

  return [{ message: 'Email confirmation code sent.' }, null] as const;
}

const updateAccountConfirmCode = async (userId: string) => {
  const code = generateEmailConfirmCode();
  await prisma.account.update({
    where: { userId },
    data: { emailConfirmCode: code },
  });
  return code;
};

export async function sendResetPasswordCode(email: string) {
  const account = await prisma.account.findFirst({
    where: { email },
  });

  if (!account) {
    return [null, generateError('Invalid email.')] as const;
  }

  const code = await updateForgotPasswordCode(account.userId);
  const url = `${env.CLIENT_URL}/reset-password?code=${code}&userId=${account.userId}`

  if (env.DEV_MODE) {
    return [{ message: `DEV MODE: Password reset link: ${url}` }, null] as const;
  }

  sendResetPasswordMail(url, account.email);

  return [{ message: 'Password reset link sent to your email.' }, null] as const;
}

const updateForgotPasswordCode = async (userId: string) => {
  const code = generateSecureCode();

  await prisma.account.update({
    where: { userId },
    data: { 
      resetPasswordCode: code,
      resetPasswordCodeExpiresAt: dateToDateTime(new Date(Date.now() + 60 * 60 * 1000)) // expires in 1 hour
     },
  });
  return code;
};

export async function verifyEmailConfirmCode(userId: string, code: string) {
  const account = await getAccountByUserId(userId);

  if (!account) {
    return [null, generateError('Invalid userId.')] as const;
  }

  if (account.emailConfirmed) {
    return [null, generateError('Email already verified.')] as const;
  }

  if (!account.emailConfirmCode) {
    return [
      null,
      generateError('You must request email verification first.'),
    ] as const;
  }

  if (account.emailConfirmCode !== code) {
    return [null, generateError('Invalid code.')] as const;
  }

  await updateAccountEmailConfirmed(userId);

  await removeUserCacheByUserIds([userId]);
  return [true, null] as const;
}

const getAccountByUserId = async (userId: string) => {
  return prisma.account.findFirst({
    where: { userId },
    select: {
      emailConfirmed: true,
      email: true,
      emailConfirmCode: true,
      user: true,
      password: true,
      passwordVersion: true,
    },
  });
};

const updateAccountEmailConfirmed = async (userId: string) => {
  const code = generateEmailConfirmCode();
  await prisma.account.update({
    where: { userId },
    data: {
      emailConfirmed: true,
      emailConfirmCode: null,
    },
  });
  return code;
};

export async function deleteAccount(userId: string, bot?: boolean) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      account: {
        select: { id: true, _count: { select: { applications: true } } },
      },
      _count: { select: { servers: true } },
    },
  });

  if (!user) {
    return [null, generateError('Invalid userId.')] as const;
  }

  if (!bot) {
    if (user?._count.servers) {
      return [
        null,
        generateError(
          'You must leave all servers before deleting your account.'
        ),
      ] as const;
    }
    if (user?.account?._count.applications) {
      return [
        null,
        generateError(
          'You must delete all applications before deleting your account.'
        ),
      ] as const;
    }
  }

  await deleteAccountFromDatabase(userId, bot);

  await removeUserCacheByUserIds([userId]);

  disconnectSockets(userId);

  return [true, null] as const;
}

const deleteAccountFromDatabase = async (userId: string, bot?: boolean) => {
  await prisma.$transaction([
    prisma.follower.deleteMany({
      where: {
        OR: [{ followedById: userId }, { followedToId: userId }],
      },
    }),
    prisma.userProfile.deleteMany({ where: { userId } }),
    prisma.serverChannelLastSeen.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: {
        avatar: null,
        banner: null,
        badges: 0,

        customStatus: null,
        username: `Deleted ${bot ? 'Bot' : 'User'} ${generateTag()}`,
      },
    }),
    prisma.account.deleteMany({
      where: { userId },
    }),
    prisma.userDevice.deleteMany({ where: { userId } }),
    prisma.userConnection.deleteMany({ where: { userId } }),
    prisma.chatNotice.deleteMany({ where: { userId } }),
    prisma.userNotice.deleteMany({ where: { userId } }),
  ]);
};

export const disconnectSockets = (userId: string, excludeSocketId?: string) => {
  let broadcaster = getIO().in(userId);
  if (excludeSocketId) {
    broadcaster = broadcaster.except(excludeSocketId);
  }
  broadcaster.emit(AUTHENTICATE_ERROR, { message: 'Invalid Token' });
  broadcaster.disconnectSockets(true);
};

export const resetPassword = async (opts: {userId: string, code: string, newPassword: string}) => {
  if (!opts.code) {
    return [null, generateError('Invalid code.')] as const
  }
  if (!opts.newPassword) {
    return [null, generateError('Invalid password.')] as const
  }
  if (!opts.userId) {
    return [null, generateError('Invalid userId.')] as const
  }

  const account = await prisma.account.findFirst({
    where: { 
      userId: opts.userId,
      resetPasswordCode: opts.code,
      resetPasswordCodeExpiresAt: { gte: new Date() }
    },
  })

  if (!account) {
    return [null, generateError('Invalid or expired code.')] as const
  }

  const updateResult = await prisma.account.update({
    where: { userId: opts.userId },
    data: {
      password: await bcrypt.hash(opts.newPassword.trim(), 10),
      passwordVersion: { increment: 1 },
      resetPasswordCode: null,
      resetPasswordCodeExpiresAt: null
    }
  })
  await removeUserCacheByUserIds([opts.userId]);

  const newToken = generateToken(account.userId, updateResult.passwordVersion)

  if (newToken) {
    disconnectSockets(opts.userId);
  }

  return [newToken, null] as const

}