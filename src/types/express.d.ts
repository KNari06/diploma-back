// Global Express Request augmentation
// Uses inline type to avoid import (which would make this a module and break ambient declaration)
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name?: string;
        role: string;
        status?: string;
      };
    }
  }
}

export {};
